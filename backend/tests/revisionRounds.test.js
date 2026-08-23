const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    RevisionRoundError,
    normalizeRoundInput,
    createRevisionRoundService,
} = require('../services/contractAnalysis/revisionRounds');
const {
    VersionSnapshotError,
    createContractVersionSnapshot,
    removeLocalVersionArtifact,
} = require('../services/contractAnalysis/version');

const createMemoryDatabase = (seed = {}) => {
    const tables = Object.fromEntries(Object.entries(seed).map(([name, rows]) => [name, rows.map((row) => ({ ...row }))]));
    const nextIds = {};
    const rowsFor = (name) => {
        if (!tables[name]) tables[name] = [];
        return tables[name];
    };

    class Query {
        constructor(table) {
            this.table = table;
            this.filters = [];
            this.order = null;
        }

        where(criteria) {
            this.filters.push(criteria);
            return this;
        }

        orderBy(column, direction = 'asc') {
            this.order = { column, direction };
            return this;
        }

        forUpdate() { return this; }

        async max(aliasDefinition) {
            const [[alias, column]] = Object.entries(aliasDefinition);
            const values = this.selectedRows().map((row) => Number(row[column]) || 0);
            return [{ [alias]: values.length ? Math.max(...values) : null }];
        }

        selectedRows() {
            let rows = rowsFor(this.table).filter((row) => this.filters.every((criteria) => (
                Object.entries(criteria).every(([key, value]) => String(row[key]) === String(value))
            )));
            if (this.order) {
                const factor = this.order.direction === 'desc' ? -1 : 1;
                rows = rows.slice().sort((a, b) => (Number(a[this.order.column]) - Number(b[this.order.column])) * factor);
            }
            return rows;
        }

        async first() { return this.selectedRows()[0]; }

        insert(record) {
            const rows = rowsFor(this.table);
            const maxId = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), nextIds[this.table] || 0);
            const inserted = { id: maxId + 1, ...record };
            nextIds[this.table] = inserted.id;
            rows.push(inserted);
            return { returning: async () => [{ ...inserted }] };
        }

        update(patch) {
            const rows = this.selectedRows();
            rows.forEach((row) => Object.assign(row, patch));
            return { returning: async () => rows.map((row) => ({ ...row })) };
        }

        then(resolve, reject) {
            return Promise.resolve(this.selectedRows().map((row) => ({ ...row }))).then(resolve, reject);
        }
    }

    const database = (table) => new Query(table);
    database.transaction = async (handler) => handler(database);
    database.fn = { now: () => '2026-08-23T00:00:00.000Z' };
    database.tables = tables;
    return database;
};

test('round input only accepts supported source parties and baseline views', () => {
    assert.deepEqual(normalizeRoundInput({ sourceParty: 'counterparty', baselineView: 'proposed' }), {
        sourceParty: 'counterparty',
        baselineView: 'proposed',
        parentRoundId: null,
        baseVersionId: null,
    });
    assert.throws(
        () => normalizeRoundInput({ sourceParty: 'unknown' }),
        (error) => error instanceof RevisionRoundError && error.code === 'ROUND_SOURCE_PARTY_INVALID',
    );
    assert.throws(
        () => normalizeRoundInput({ baselineView: 'markup' }),
        (error) => error instanceof RevisionRoundError && error.code === 'ROUND_BASELINE_VIEW_INVALID',
    );
});

test('legacy contracts lazily initialize exactly one round zero', async () => {
    const database = createMemoryDatabase({
        contracts: [{ id: 7, user_id: 3 }],
        contract_versions: [{ id: 9, contract_id: 7, version_no: 2 }],
        contract_rounds: [],
    });
    let snapshotCalls = 0;
    let capturedOptions;
    const service = createRevisionRoundService(database, {
        createVersionSnapshot: async (contract, action, options) => {
            snapshotCalls += 1;
            capturedOptions = options;
            const version = {
                id: 10,
                contract_id: contract.id,
                version_no: 3,
                round_id: 1,
                parent_version_id: options.parentVersionId,
            };
            database.tables.contract_versions.push(version);
            return version;
        },
    });
    const contract = { id: 7, user_id: 3 };

    const first = await service.ensureInitialRound(contract, { userId: 3 });
    const second = await service.ensureInitialRound(contract, { userId: 3 });

    assert.equal(first.id, second.id);
    assert.equal(first.round_no, 0);
    assert.equal(first.base_version_id, 10);
    assert.equal(first.working_version_id, 10);
    assert.equal(capturedOptions.parentVersionId, 9);
    assert.equal(capturedOptions.roundId, 1);
    assert.equal(snapshotCalls, 1);
    assert.equal(database.tables.contract_rounds.length, 1);
});

test('a next round requires a frozen latest round and preserves its version as baseline', async () => {
    const database = createMemoryDatabase({
        contracts: [{ id: 7, user_id: 3 }],
        contract_versions: [{ id: 9, contract_id: 7, version_no: 2, round_id: 1 }],
        contract_rounds: [{
            id: 1,
            contract_id: 7,
            round_no: 0,
            base_version_id: 9,
            working_version_id: 9,
            status: 'draft',
        }],
    });
    const service = createRevisionRoundService(database);
    const contract = { id: 7, user_id: 3 };
    await assert.rejects(
        service.createRound(contract, { sourceParty: 'counterparty' }),
        (error) => error.code === 'ROUND_NOT_FROZEN',
    );

    const frozen = await service.freezeRound(7, 1, { workingVersionId: 9 });
    const next = await service.createRound(contract, {
        sourceParty: 'counterparty',
        baselineView: 'proposed',
        userId: 3,
    });

    assert.equal(frozen.status, 'frozen');
    assert.equal(next.round_no, 1);
    assert.equal(next.parent_round_id, frozen.id);
    assert.equal(next.base_version_id, 9);
    assert.equal(next.working_version_id, null);
});

test('round version nodes carry parent, round, view, party and become the working version', async () => {
    const database = createMemoryDatabase({
        contracts: [{ id: 7, user_id: 3 }],
        contract_versions: [{ id: 9, contract_id: 7, version_no: 2 }],
        contract_rounds: [{
            id: 2,
            contract_id: 7,
            round_no: 1,
            base_version_id: 9,
            working_version_id: 9,
            source_party: 'counterparty',
            baseline_view: 'proposed',
            status: 'draft',
        }],
    });
    let captured;
    const service = createRevisionRoundService(database, {
        createVersionSnapshot: async (contract, action, options) => {
            captured = { contract, action, options };
            database.tables.contract_versions.push({
                id: 10,
                contract_id: 7,
                version_no: 3,
                parent_version_id: options.parentVersionId,
                round_id: options.roundId,
                document_view: options.documentView,
                source_party: options.sourceParty,
            });
            return { id: 10, version_no: 3, ...options };
        },
    });

    const version = await service.createRoundVersion({ id: 7, user_id: 3 }, 2, {
        sourceAction: 'counterparty-return',
    });

    assert.equal(version.id, 10);
    assert.equal(captured.action, 'counterparty-return');
    assert.deepEqual({
        parentVersionId: captured.options.parentVersionId,
        roundId: captured.options.roundId,
        documentView: captured.options.documentView,
        sourceParty: captured.options.sourceParty,
    }, {
        parentVersionId: 9,
        roundId: 2,
        documentView: 'proposed',
        sourceParty: 'counterparty',
    });
    assert.equal(database.tables.contract_rounds[0].working_version_id, 10);
    assert.deepEqual((await service.listRoundVersions(7, 2)).map((item) => item.id), [10]);
});

test('a round cannot freeze without a current-round working version', async () => {
    const database = createMemoryDatabase({
        contracts: [{ id: 7, user_id: 3 }],
        contract_versions: [{ id: 9, contract_id: 7, version_no: 2, round_id: 1 }],
        contract_rounds: [{ id: 2, contract_id: 7, round_no: 1, working_version_id: null, status: 'draft' }],
    });
    const service = createRevisionRoundService(database);
    await assert.rejects(
        service.freezeRound(7, 2),
        (error) => error.code === 'ROUND_INPUT_INVALID',
    );
    await assert.rejects(
        service.freezeRound(7, 2, { workingVersionId: 9 }),
        (error) => error.code === 'ROUND_WORKING_VERSION_INVALID',
    );
});

test('a CAS failure removes the local artifact and exposes an uncompensated OSS orphan', async () => {
    const database = createMemoryDatabase({
        contracts: [{ id: 7, user_id: 3 }],
        contract_versions: [{ id: 9, contract_id: 7, version_no: 2 }],
        contract_rounds: [{
            id: 2,
            contract_id: 7,
            round_no: 1,
            base_version_id: 9,
            working_version_id: 9,
            source_party: 'counterparty',
            baseline_view: 'proposed',
            status: 'draft',
        }],
    });
    let removed = false;
    const service = createRevisionRoundService(database, {
        createVersionSnapshot: async () => {
            database.tables.contract_rounds[0].status = 'frozen';
            return { id: 10, storage_path: '/tmp/version.docx', oss_key: 'versions/orphan.docx' };
        },
        removeLocalArtifact: async () => { removed = true; },
    });

    await assert.rejects(
        service.createRoundVersion({ id: 7, user_id: 3 }, 2),
        (error) => error.code === 'ROUND_VERSION_ORPHAN_OSS'
            && error.details.orphan_oss_key === 'versions/orphan.docx',
    );
    assert.equal(removed, true);
});

test('a stale parent version is rejected before a new artifact is created', async () => {
    const database = createMemoryDatabase({
        contracts: [{ id: 7, user_id: 3 }],
        contract_versions: [
            { id: 8, contract_id: 7, version_no: 1 },
            { id: 9, contract_id: 7, version_no: 2 },
        ],
        contract_rounds: [{
            id: 2,
            contract_id: 7,
            round_no: 1,
            base_version_id: 8,
            working_version_id: 9,
            source_party: 'thinkpark',
            baseline_view: 'proposed',
            status: 'draft',
        }],
    });
    let snapshotCalled = false;
    const service = createRevisionRoundService(database, {
        createVersionSnapshot: async () => { snapshotCalled = true; },
    });
    await assert.rejects(
        service.createRoundVersion({ id: 7, user_id: 3 }, 2, { parentVersionId: 8 }),
        (error) => error.code === 'ROUND_VERSION_PARENT_STALE',
    );
    assert.equal(snapshotCalled, false);
});

test('version snapshot extracts text from the immutable copy instead of the live contract path', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'round-version-'));
    const livePath = path.join(tempDir, 'live.docx');
    fs.writeFileSync(livePath, 'current-content');
    const database = createMemoryDatabase({ contract_versions: [] });
    let extractedPath = null;
    try {
        const version = await createContractVersionSnapshot(
            { id: 7, user_id: 3, storage_path: livePath },
            'round-test',
            {
                database,
                snapshotDir: path.join(tempDir, 'versions'),
                extractText: async (filePath) => {
                    extractedPath = filePath;
                    fs.writeFileSync(livePath, 'changed-after-copy');
                    return fs.readFileSync(filePath, 'utf8');
                },
                mirrorFile: async () => ({ oss_key: null, sha256: null }),
            },
        );
        assert.notEqual(extractedPath, livePath);
        assert.equal(database.tables.contract_versions[0].plain_text, 'current-content');
        assert.equal(fs.readFileSync(version.storage_path, 'utf8'), 'current-content');
        await removeLocalVersionArtifact(version);
        assert.equal(fs.existsSync(version.storage_path), false);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('failed version insert removes the local copy and reports the OSS compensation boundary', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'round-version-fail-'));
    const livePath = path.join(tempDir, 'live.docx');
    fs.writeFileSync(livePath, 'current-content');
    const database = createMemoryDatabase({ contract_versions: [] });
    // Make only the final DB insert fail after a successful mirror.
    const failingDatabase = (table) => {
        const query = database(table);
        if (table === 'contract_versions') {
            query.insert = () => ({ returning: async () => { throw new Error('DB_DOWN'); } });
        }
        return query;
    };
    failingDatabase.fn = database.fn;
    try {
        await assert.rejects(
            createContractVersionSnapshot(
                { id: 7, user_id: 3, storage_path: livePath },
                'round-test',
                {
                    database: failingDatabase,
                    snapshotDir: path.join(tempDir, 'versions'),
                    extractText: async (filePath) => fs.readFileSync(filePath, 'utf8'),
                    mirrorFile: async () => ({ oss_key: 'versions/orphan.docx', sha256: 'abc' }),
                },
            ),
            (error) => error instanceof VersionSnapshotError
                && error.ossCompensationRequired
                && error.orphanOssKey === 'versions/orphan.docx',
        );
        const files = fs.existsSync(path.join(tempDir, 'versions'))
            ? fs.readdirSync(path.join(tempDir, 'versions'))
            : [];
        assert.deepEqual(files, []);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('schema initialization serializes replicas and refuses duplicate contract version numbers', () => {
    const source = fs.readFileSync(path.join(__dirname, '../database-check.js'), 'utf8');
    assert.match(source, /pg_advisory_lock/);
    assert.match(source, /pg_advisory_unlock/);
    assert.match(source, /CONTRACT_VERSION_DUPLICATES/);
    assert.match(source, /CREATE UNIQUE INDEX IF NOT EXISTS contract_versions_contract_version_no_uidx/);
});
