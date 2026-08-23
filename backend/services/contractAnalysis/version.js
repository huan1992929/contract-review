/**
 * @file services/contractAnalysis/version.js
 * @brief 管理合同版本快照与文本差异对比
 *
 * 核心职责：
 * - 在合同被修改前创建版本快照，复制原文件并提取纯文本
 * - 基于最长公共子序列算法计算前后文本差异
 *
 * 关键实现：
 * - createContractVersionSnapshot 自增版本号并落盘到 uploads/versions
 * - diffText 按空白分词后用动态规划计算 equal/insert/delete 序列
 *
 * 依赖关系：
 * - 上游：../../database、fs、path、uuid、./fileExtraction
 * - 下游：被合同编辑、替换文本等需要版本回溯的流程调用
 */
const db = require('../../database');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { extractTextFromFile } = require('./fileExtraction');
const { mirrorContractFile } = require('../thinkparkStorageGateway');

class VersionSnapshotError extends Error {
    constructor(code, message, options = {}) {
        super(message, options.cause ? { cause: options.cause } : undefined);
        this.name = 'VersionSnapshotError';
        this.code = code;
        this.orphanOssKey = options.orphanOssKey || null;
        this.ossCompensationRequired = Boolean(options.orphanOssKey);
    }
}

const fileSha256 = async (filePath) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    for await (const chunk of stream) hash.update(chunk);
    return hash.digest('hex');
};

const createContractVersionSnapshot = async (contract, sourceAction = 'replace-text', snapshotOptions = {}) => {
    let options = snapshotOptions;
    let action = sourceAction;
    if (sourceAction && typeof sourceAction === 'object') {
        options = sourceAction;
        action = options.sourceAction || 'replace-text';
    }
    if (!options.database) {
        let stagedVersion = null;
        try {
            return await db.transaction(async (trx) => {
                await trx('contracts').where({ id: contract.id }).forUpdate().first();
                stagedVersion = await createContractVersionSnapshot(contract, action, {
                    ...options,
                    database: trx,
                });
                return stagedVersion;
            });
        } catch (error) {
            if (stagedVersion?.storage_path) {
                await fs.promises.rm(stagedVersion.storage_path, { force: true }).catch(() => {});
            }
            if (stagedVersion?.oss_key) {
                throw new VersionSnapshotError(
                    'VERSION_SNAPSHOT_ORPHAN_OSS',
                    '版本事务已回滚，本地快照已清理；OSS 镜像需要人工清理。',
                    { cause: error, orphanOssKey: stagedVersion.oss_key },
                );
            }
            throw error;
        }
    }
    const database = options.database || db;
    const extractText = options.extractText || extractTextFromFile;
    const mirrorFile = options.mirrorFile || mirrorContractFile;
    const [{ next_version_no: nextVersionNo }] = await database('contract_versions')
        .where({ contract_id: contract.id })
        .max({ next_version_no: 'version_no' });
    const versionNo = Number(nextVersionNo || 0) + 1;
    const ext = path.extname(contract.storage_path).toLowerCase();
    const snapshotDir = options.snapshotDir || path.join(__dirname, '..', '..', 'uploads', 'versions');
    await fs.promises.mkdir(snapshotDir, { recursive: true });
    const snapshotPath = path.join(snapshotDir, `${contract.id}-v${versionNo}-${uuidv4()}${ext}`);
    let mirrored = null;
    try {
        await fs.promises.copyFile(contract.storage_path, snapshotPath);
        const contentSha256 = await fileSha256(snapshotPath);

        let plainText = '';
        try {
            // The immutable copied artifact is authoritative. Reading the live path here can
            // mix a later OnlyOffice save with the earlier snapshot hash.
            plainText = await extractText(snapshotPath);
        } catch (error) {
            plainText = '';
        }

        mirrored = await mirrorFile(snapshotPath, {
            owner: `user-${contract.user_id}`,
            contractId: contract.id,
            version: `snapshot-${versionNo}`,
        });
        const [version] = await database('contract_versions').insert({
            contract_id: contract.id,
            user_id: contract.user_id,
            version_no: versionNo,
            source_action: action,
            storage_path: snapshotPath,
            plain_text: plainText,
            oss_key: mirrored.oss_key,
            oss_sha256: mirrored.sha256,
            content_sha256: contentSha256,
            parent_version_id: options.parentVersionId || null,
            round_id: options.roundId || null,
            document_view: options.documentView || null,
            source_party: options.sourceParty || null,
        }).returning([
            'id',
            'version_no',
            'created_at',
            'source_action',
            'storage_path',
            'oss_key',
            'oss_sha256',
            'parent_version_id',
            'round_id',
            'document_view',
            'source_party',
            'content_sha256',
        ]);

        return version || {
            version_no: versionNo,
            source_action: action,
            storage_path: snapshotPath,
            oss_key: mirrored.oss_key,
            oss_sha256: mirrored.sha256,
            parent_version_id: options.parentVersionId || null,
            round_id: options.roundId || null,
            document_view: options.documentView || null,
            source_party: options.sourceParty || null,
            content_sha256: contentSha256,
        };
    } catch (error) {
        await fs.promises.rm(snapshotPath, { force: true }).catch(() => {});
        if (error instanceof VersionSnapshotError) throw error;
        throw new VersionSnapshotError(
            'VERSION_SNAPSHOT_FAILED',
            mirrored?.oss_key
                ? '版本快照提交失败；OSS 镜像已创建但存储网关没有删除接口，需要人工清理。'
                : '版本快照创建失败。',
            { cause: error, orphanOssKey: mirrored?.oss_key },
        );
    }
};

const removeLocalVersionArtifact = async (version) => {
    if (!version?.storage_path) return false;
    await fs.promises.rm(version.storage_path, { force: true });
    return true;
};

const diffText = (before, after) => {
    const beforeParts = String(before || '').split(/(\s+)/);
    const afterParts = String(after || '').split(/(\s+)/);
    const rows = Array.from({ length: beforeParts.length + 1 }, () => Array(afterParts.length + 1).fill(0));

    for (let i = beforeParts.length - 1; i >= 0; i -= 1) {
        for (let j = afterParts.length - 1; j >= 0; j -= 1) {
            rows[i][j] = beforeParts[i] === afterParts[j]
                ? rows[i + 1][j + 1] + 1
                : Math.max(rows[i + 1][j], rows[i][j + 1]);
        }
    }

    const changes = [];
    let i = 0;
    let j = 0;
    while (i < beforeParts.length && j < afterParts.length) {
        if (beforeParts[i] === afterParts[j]) {
            changes.push({ type: 'equal', text: beforeParts[i] });
            i += 1;
            j += 1;
        } else if (rows[i + 1][j] >= rows[i][j + 1]) {
            changes.push({ type: 'delete', text: beforeParts[i] });
            i += 1;
        } else {
            changes.push({ type: 'insert', text: afterParts[j] });
            j += 1;
        }
    }
    while (i < beforeParts.length) changes.push({ type: 'delete', text: beforeParts[i++] });
    while (j < afterParts.length) changes.push({ type: 'insert', text: afterParts[j++] });
    return changes.filter((item) => item.text);
};

module.exports = {
    VersionSnapshotError,
    createContractVersionSnapshot,
    removeLocalVersionArtifact,
    fileSha256,
    diffText,
};
