/**
 * @file services/contractAnalysis/revisionRounds.js
 * @brief 合同多轮谈判、版本节点与条款修订账本的基础服务
 *
 * 设计边界：
 * - 旧合同按需初始化第 0 轮，不批量回填、不改写历史 DOCX。
 * - 每轮只承载当前红线；上一轮通过不可变 contract_versions 节点保留。
 * - DOCX 书签不是条款身份来源，稳定条款身份由 contract_clauses 保存。
 */
const db = require('../../database');
const { createContractVersionSnapshot, removeLocalVersionArtifact } = require('./version');

const SOURCE_PARTIES = new Set(['system', 'thinkpark', 'counterparty', 'ai', 'import']);
const BASELINE_VIEWS = new Set(['accepted', 'proposed', 'original']);

class RevisionRoundError extends Error {
    constructor(code, message, status = 400, details = {}) {
        super(message);
        this.name = 'RevisionRoundError';
        this.code = code;
        this.status = status;
        this.details = details;
    }
}

const positiveId = (value, field, { nullable = true } = {}) => {
    if ((value === null || value === undefined || value === '') && nullable) return null;
    const normalized = Number(value);
    if (!Number.isInteger(normalized) || normalized <= 0) {
        throw new RevisionRoundError('ROUND_INPUT_INVALID', `${field} 必须是正整数。`);
    }
    return normalized;
};

const normalizeRoundInput = (input = {}) => {
    const sourceParty = String(input.sourceParty || input.source_party || 'thinkpark').trim().toLowerCase();
    const baselineView = String(input.baselineView || input.baseline_view || 'proposed').trim().toLowerCase();
    if (!SOURCE_PARTIES.has(sourceParty)) {
        throw new RevisionRoundError('ROUND_SOURCE_PARTY_INVALID', '不支持的修订来源。');
    }
    if (!BASELINE_VIEWS.has(baselineView)) {
        throw new RevisionRoundError('ROUND_BASELINE_VIEW_INVALID', '不支持的基线视图。');
    }
    return {
        sourceParty,
        baselineView,
        parentRoundId: positiveId(input.parentRoundId ?? input.parent_round_id, 'parentRoundId'),
        baseVersionId: positiveId(input.baseVersionId ?? input.base_version_id, 'baseVersionId'),
    };
};

const returnedRow = (value) => (Array.isArray(value) ? (value[0] || null) : (value || null));

const createRevisionRoundService = (database = db, dependencies = {}) => {
    const snapshotCreator = dependencies.createVersionSnapshot || createContractVersionSnapshot;
    const removeLocalArtifact = dependencies.removeLocalArtifact || removeLocalVersionArtifact;

    const compensateRolledBackSnapshot = async (version, cause) => {
        if (!version) {
            if (cause?.ossCompensationRequired) {
                throw new RevisionRoundError(
                    'ROUND_VERSION_ORPHAN_OSS',
                    cause.message,
                    500,
                    { orphan_oss_key: cause.orphanOssKey, cause_code: cause.code || null },
                );
            }
            throw cause;
        }
        await removeLocalArtifact(version).catch(() => {});
        if (version.oss_key) {
            throw new RevisionRoundError(
                'ROUND_VERSION_ORPHAN_OSS',
                '版本提交已回滚，本地快照已清理；存储网关没有删除接口，OSS 镜像需要人工清理。',
                500,
                { orphan_oss_key: version.oss_key, cause_code: cause?.code || null },
            );
        }
        throw cause;
    };

    const ensureVersionBelongsToContract = async (trx, contractId, versionId, field = 'versionId') => {
        if (!versionId) return null;
        const version = await trx('contract_versions').where({ id: versionId, contract_id: contractId }).first();
        if (!version) {
            throw new RevisionRoundError('ROUND_VERSION_NOT_FOUND', `${field} 不属于当前合同。`, 404);
        }
        return version;
    };

    const ensureInitialRound = async (contract, options = {}) => {
        let stagedVersion = null;
        try {
            return await database.transaction(async (trx) => {
                await trx('contracts').where({ id: contract.id }).forUpdate().first();
                const existing = await trx('contract_rounds')
                    .where({ contract_id: contract.id })
                    .orderBy('round_no', 'asc')
                    .first();
                if (existing) return existing;

                const latestVersion = await trx('contract_versions')
                    .where({ contract_id: contract.id })
                    .orderBy('version_no', 'desc')
                    .first();
                const inserted = returnedRow(await trx('contract_rounds').insert({
                    contract_id: contract.id,
                    round_no: 0,
                    parent_round_id: null,
                    base_version_id: null,
                    working_version_id: null,
                    source_party: 'system',
                    baseline_view: 'original',
                    status: 'draft',
                    created_by: options.userId || contract.user_id || null,
                }).returning('*'));

                // A legacy snapshot is an edit-before image, not necessarily the current
                // document. Materialize the live current file as round zero's authoritative node.
                stagedVersion = await snapshotCreator(contract, 'round-0-current', {
                    database: trx,
                    parentVersionId: latestVersion?.id || null,
                    roundId: inserted.id,
                    documentView: 'original',
                    sourceParty: 'system',
                });
                const updated = returnedRow(await trx('contract_rounds')
                    .where({ id: inserted.id, contract_id: contract.id, status: 'draft' })
                    .update({
                        base_version_id: stagedVersion.id,
                        working_version_id: stagedVersion.id,
                        updated_at: trx.fn.now(),
                    })
                    .returning('*'));
                if (!updated) {
                    throw new RevisionRoundError('ROUND_INITIALIZATION_CONFLICT', '第 0 轮初始化发生并发冲突。', 409);
                }
                return updated;
            });
        } catch (error) {
            return compensateRolledBackSnapshot(stagedVersion, error);
        }
    };

    const listRounds = async (contractId) => database('contract_rounds')
        .where({ contract_id: contractId })
        .orderBy('round_no', 'asc');

    const listRoundVersions = async (contractId, roundId) => {
        const normalizedRoundId = positiveId(roundId, 'roundId', { nullable: false });
        const round = await database('contract_rounds').where({ id: normalizedRoundId, contract_id: contractId }).first();
        if (!round) throw new RevisionRoundError('ROUND_NOT_FOUND', '轮次不存在。', 404);
        return database('contract_versions')
            .where({ contract_id: contractId, round_id: round.id })
            .orderBy('version_no', 'asc');
    };

    const createRound = async (contract, input = {}) => {
        await ensureInitialRound(contract, { userId: input.userId });
        const normalized = normalizeRoundInput(input);
        return database.transaction(async (trx) => {
            await trx('contracts').where({ id: contract.id }).forUpdate().first();
            const latest = await trx('contract_rounds')
                .where({ contract_id: contract.id })
                .orderBy('round_no', 'desc')
                .first();
            if (!latest) {
                throw new RevisionRoundError('ROUND_INITIALIZATION_FAILED', '第 0 轮初始化失败。', 500);
            }
            if (latest.status !== 'frozen') {
                throw new RevisionRoundError('ROUND_NOT_FROZEN', '请先冻结当前轮次，再创建下一轮。', 409);
            }

            const parentRoundId = normalized.parentRoundId || latest.id;
            const parentRound = await trx('contract_rounds')
                .where({ id: parentRoundId, contract_id: contract.id })
                .first();
            if (!parentRound) {
                throw new RevisionRoundError('ROUND_PARENT_NOT_FOUND', '父轮次不存在。', 404);
            }
            if (parentRound.id !== latest.id) {
                throw new RevisionRoundError('ROUND_PARENT_STALE', '只能基于最新冻结轮次创建下一轮。', 409);
            }

            const baseVersionId = normalized.baseVersionId
                || parentRound.working_version_id
                || parentRound.base_version_id
                || null;
            if (!baseVersionId) {
                throw new RevisionRoundError('ROUND_BASE_VERSION_REQUIRED', '冻结轮次缺少可继承的工作版本。', 409);
            }
            await ensureVersionBelongsToContract(trx, contract.id, baseVersionId, 'baseVersionId');
            const inserted = await trx('contract_rounds').insert({
                contract_id: contract.id,
                round_no: Number(latest.round_no) + 1,
                parent_round_id: parentRound.id,
                base_version_id: baseVersionId,
                working_version_id: null,
                source_party: normalized.sourceParty,
                baseline_view: normalized.baselineView,
                status: 'draft',
                created_by: input.userId || contract.user_id || null,
            }).returning('*');
            return returnedRow(inserted);
        });
    };

    const freezeRound = async (contractId, roundId, input = {}) => database.transaction(async (trx) => {
        const normalizedRoundId = positiveId(roundId, 'roundId', { nullable: false });
        await trx('contracts').where({ id: contractId }).forUpdate().first();
        const round = await trx('contract_rounds').where({ id: normalizedRoundId, contract_id: contractId }).first();
        if (!round) throw new RevisionRoundError('ROUND_NOT_FOUND', '轮次不存在。', 404);
        if (round.status === 'frozen') return round;
        if (round.status !== 'draft') {
            throw new RevisionRoundError('ROUND_STATUS_INVALID', '只有草稿轮次可以冻结。', 409);
        }
        const workingVersionId = positiveId(
            input.workingVersionId ?? input.working_version_id ?? round.working_version_id,
            'workingVersionId',
            { nullable: false },
        );
        const workingVersion = await ensureVersionBelongsToContract(trx, contractId, workingVersionId, 'workingVersionId');
        if (Number(workingVersion.round_id) !== Number(round.id)) {
            throw new RevisionRoundError('ROUND_WORKING_VERSION_INVALID', '工作版本必须由当前轮次生成。', 409);
        }
        const updated = await trx('contract_rounds').where({ id: round.id }).update({
            working_version_id: workingVersionId,
            status: 'frozen',
            frozen_at: trx.fn.now(),
            updated_at: trx.fn.now(),
        }).returning('*');
        return returnedRow(updated);
    });

    const createRoundVersion = async (contract, roundId, input = {}) => {
        const normalizedRoundId = positiveId(roundId, 'roundId', { nullable: false });
        let stagedVersion = null;
        try {
            return await database.transaction(async (trx) => {
                await trx('contracts').where({ id: contract.id }).forUpdate().first();
                const round = await trx('contract_rounds')
                    .where({ id: normalizedRoundId, contract_id: contract.id })
                    .forUpdate()
                    .first();
                if (!round) throw new RevisionRoundError('ROUND_NOT_FOUND', '轮次不存在。', 404);
                if (round.status !== 'draft') {
                    throw new RevisionRoundError('ROUND_FROZEN', '冻结轮次不能再写入版本。', 409);
                }
                const expectedParentVersionId = round.working_version_id || round.base_version_id || null;
                const parentVersionId = positiveId(
                    input.parentVersionId ?? input.parent_version_id ?? expectedParentVersionId,
                    'parentVersionId',
                );
                if (parentVersionId !== expectedParentVersionId) {
                    throw new RevisionRoundError('ROUND_VERSION_PARENT_STALE', '工作版本已变化，请刷新后重试。', 409);
                }
                await ensureVersionBelongsToContract(trx, contract.id, parentVersionId, 'parentVersionId');
                const normalized = normalizeRoundInput({
                    sourceParty: input.sourceParty || input.source_party || round.source_party,
                    baselineView: input.documentView || input.document_view || round.baseline_view,
                });
                stagedVersion = await snapshotCreator(
                    contract,
                    input.sourceAction || input.source_action || 'round-snapshot',
                    {
                        database: trx,
                        parentVersionId,
                        roundId: round.id,
                        documentView: normalized.baselineView,
                        sourceParty: normalized.sourceParty,
                    },
                );
                const updated = returnedRow(await trx('contract_rounds').where({
                    id: round.id,
                    contract_id: contract.id,
                    status: 'draft',
                    working_version_id: round.working_version_id,
                }).update({
                    working_version_id: stagedVersion.id,
                    updated_at: trx.fn.now(),
                }).returning('*'));
                if (!updated) {
                    throw new RevisionRoundError('ROUND_VERSION_COMMIT_CONFLICT', '轮次状态已变化，版本未提交。', 409);
                }
                return stagedVersion;
            });
        } catch (error) {
            return compensateRolledBackSnapshot(stagedVersion, error);
        }
    };

    return {
        ensureInitialRound,
        listRounds,
        listRoundVersions,
        createRound,
        freezeRound,
        createRoundVersion,
    };
};

const defaultService = createRevisionRoundService();

module.exports = {
    SOURCE_PARTIES,
    BASELINE_VIEWS,
    RevisionRoundError,
    positiveId,
    normalizeRoundInput,
    createRevisionRoundService,
    ...defaultService,
};
