#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const db = require('../database');
const initializeDatabase = require('../database-check');
const { parseCaseJsonDocument } = require('../services/caseJsonParser');
const { importKnowledgeEntries, quarantineKnowledgeDocuments } = require('../services/vectorStore');

const apply = process.argv.includes('--apply');
const caseDir = path.join(__dirname, '..', 'data', 'official_contract_cases');

async function main() {
    await initializeDatabase();
    const legacyQuery = db('vector_documents')
        .where({ source_type: 'case' })
        .andWhere('source_name', 'like', '%candidate_55192%');
    const legacyCountRow = await legacyQuery.clone().count({ count: '*' }).first();
    const caseFiles = fs.readdirSync(caseDir).filter((name) => name.endsWith('.json')).sort();
    const entries = caseFiles.map((name) => {
        const filePath = path.join(caseDir, name);
        const parsed = parseCaseJsonDocument(JSON.parse(fs.readFileSync(filePath, 'utf8')), {
            sourceFile: path.relative(path.join(__dirname, '..'), filePath),
        });
        if (!parsed) throw new Error(`无法解析官方案例：${name}`);
        return parsed;
    });
    const plan = {
        mode: apply ? 'apply' : 'dry-run',
        legacy_case_chunks_to_quarantine: Number(legacyCountRow?.count || 0),
        official_case_documents_to_import: entries.length,
        official_case_titles: entries.map((entry) => entry.title),
    };
    console.log(JSON.stringify(plan, null, 2));
    if (!apply) return;

    const quarantine = await quarantineKnowledgeDocuments({
        sourceType: 'case',
        sourceNameIncludes: 'candidate_55192',
        reason: '历史案例数据与合同审查业务无关，已由最高人民法院官方合同案例替换',
        operator: 'knowledge-governance-migration',
    });
    const imported = await importKnowledgeEntries(entries);
    const result = { quarantine, imported };
    console.log(JSON.stringify(result, null, 2));
}

main()
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => db.destroy());
