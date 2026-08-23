/**
 * @file database-check.js
 * @brief 数据库 Schema 校验与重建脚本,启动时幂等创建所有业务表
 *
 * 核心职责：
 * - 检测并创建缺失的数据表(users/contracts/contract_versions/contract_groups/qa_history/focused_reviews/law_versions/standard_clauses/review_templates/template_versions)
 * - 通过 ensureColumn 幂等补齐向量库与法律时效性字段
 * - 调用 ensureVectorStore 初始化向量检索相关表
 *
 * 关键实现：
 * - resetAndRebuildDatabase 采用"不存在则创建"策略,避免破坏已有数据
 * - ensureColumn 封装 hasColumn 检测,缺失时执行 addColumn 回调
 * - 失败时调用 process.exit(1) 终止进程,避免带病启动
 *
 * 依赖关系：
 * - 上游：database(Knex 实例)、services/vectorStore
 * - 下游：被 index.js 在 startServer 中调用
 */

const db = require('./database');
const { ensureVectorStore } = require('./services/vectorStore');
const { hashPassword, verifyPassword } = require('./services/appAuth');

// Every application replica runs the schema verifier. A session-scoped PostgreSQL
// advisory lock serializes the hasColumn/ALTER sequence across replicas.
const SCHEMA_ADVISORY_LOCK_ID = 742391104;

async function ensureColumn(tableName, columnName, addColumn) {
  const exists = await db.schema.hasColumn(tableName, columnName);
  if (!exists) {
    console.log(`[DB Init] Adding ${tableName}.${columnName}...`);
    await db.schema.table(tableName, addColumn);
  }
}

async function resetAndRebuildDatabase() {
  console.log('[DB Init] Starting database schema verification and rebuild...');
  let schemaLockConnection = null;
  let fatalError = null;
  try {
    if (Number(db.client.pool?.max || 0) === 1) {
      throw new Error('DB_POOL_MAX_MUST_BE_AT_LEAST_2_FOR_SCHEMA_ADVISORY_LOCK');
    }
    schemaLockConnection = await db.client.acquireConnection();
    await db.raw('SELECT pg_advisory_lock(?)', [SCHEMA_ADVISORY_LOCK_ID]).connection(schemaLockConnection);
    const hasUsersTable = await db.schema.hasTable('users');
    if (!hasUsersTable) {
        console.log('[DB Init] Creating new `users` table...');
        await db.schema.createTable('users', (table) => {
            table.increments('id').primary();
            table.string('fingerprint_id').notNullable().unique();
            table.timestamps(true, true);
        });
        console.log('[DB Init] New `users` table created successfully.');
    }

    await ensureColumn('users', 'username', (table) => table.string('username').unique());
    await ensureColumn('users', 'password_hash', (table) => table.text('password_hash'));
    await ensureColumn('users', 'display_name', (table) => table.string('display_name'));
    await ensureColumn('users', 'role', (table) => table.string('role').defaultTo('reviewer'));
    await ensureColumn('users', 'is_active', (table) => table.boolean('is_active').notNullable().defaultTo(true));
    await ensureColumn('users', 'last_login_at', (table) => table.timestamp('last_login_at'));

    const seedUsername = String(process.env.APP_AUTH_USERNAME || '').trim().toLowerCase();
    const seedPassword = String(process.env.APP_AUTH_PASSWORD || '');
    if (seedUsername && seedPassword) {
      const bindUserId = Number(process.env.APP_AUTH_BIND_USER_ID || 0);
      const existingAccount = await db('users').whereRaw('LOWER(username) = ?', [seedUsername]).first()
        || (bindUserId > 0 ? await db('users').where({ id: bindUserId }).first() : null);
      const passwordHash = existingAccount?.password_hash && verifyPassword(seedPassword, existingAccount.password_hash)
        ? existingAccount.password_hash
        : hashPassword(seedPassword);
      if (existingAccount) {
        await db('users').where({ id: existingAccount.id }).update({
          username: seedUsername,
          password_hash: passwordHash,
          display_name: process.env.APP_AUTH_DISPLAY_NAME || '众安测试账号',
          role: process.env.APP_AUTH_ROLE || 'reviewer',
          is_active: true,
          updated_at: db.fn.now(),
        });
      } else {
        await db('users').insert({
          fingerprint_id: `account:${seedUsername}`,
          username: seedUsername,
          password_hash: passwordHash,
          display_name: process.env.APP_AUTH_DISPLAY_NAME || '众安测试账号',
          role: process.env.APP_AUTH_ROLE || 'reviewer',
          is_active: true,
        });
      }
      console.log(`[DB Init] Application login account ready: ${seedUsername}`);
    }

    const hasContractsTable = await db.schema.hasTable('contracts');
    
    if (hasContractsTable) {
      // Table already exists, so we do nothing.
      // The logic in database.js will handle any necessary column additions.
      console.log('[DB Init] `contracts` table already exists. Skipping creation.');
    } else {
      // Only create the table if it does not exist.
      console.log('[DB Init] Creating new `contracts` table with the latest schema...');
      await db.schema.createTable('contracts', (table) => {
        table.increments('id').primary();
        table.integer('user_id').unsigned().references('id').inTable('users').onDelete('CASCADE');
        table.string('original_filename').notNullable();
        table.string('storage_path').notNullable();
        table.string('document_key').unique();
        table.string('perspective'); // To store the user's review perspective (e.g., '甲方')
        table.text('analysis_result'); // To store the JSON result from the AI analysis
        table.text('pre_analysis_data'); // To store the full payload from the pre-analysis/setup step
        table.string('status'); // To track the contract's state (e.g., 'Uploaded', 'Reviewed')
        table.text('pre_analysis_cache'); // Add column to cache pre-analysis results
        table.timestamps(true, true);
      });
      console.log('[DB Init] New `contracts` table created successfully. Schema is now up-to-date.');
    }

    await ensureColumn('contracts', 'analysis_partial_result', (table) => table.text('analysis_partial_result'));
    await ensureColumn('contracts', 'analysis_status', (table) => table.string('analysis_status'));
    await ensureColumn('contracts', 'group_id', (table) => table.integer('group_id').unsigned());
    await ensureColumn('contracts', 'oss_key', (table) => table.text('oss_key'));
    await ensureColumn('contracts', 'oss_sha256', (table) => table.string('oss_sha256', 64));
    await ensureColumn('contracts', 'onlyoffice_saved_at', (table) => table.timestamp('onlyoffice_saved_at'));
    await ensureColumn('contracts', 'onlyoffice_saved_key', (table) => table.string('onlyoffice_saved_key'));

    // 审核结果按“逻辑审核文本+模板+立场+知识库发布+策略+模型设置”指纹复用。
    // 表中不保存 user_id、文件名、存储路径或 OnlyOffice key，避免跨用户泄露文件信息。
    const hasReviewResultCacheTable = await db.schema.hasTable('review_result_cache');
    if (!hasReviewResultCacheTable) {
      console.log('[DB Init] Creating new `review_result_cache` table...');
      await db.schema.createTable('review_result_cache', (table) => {
        table.string('fingerprint', 64).primary();
        table.string('document_sha256', 64).notNullable().index();
        table.string('logical_text_sha256', 64).notNullable().index();
        table.string('template_id', 128).notNullable();
        table.string('perspective', 256).notNullable();
        table.string('contract_type', 256).notNullable();
        table.string('knowledge_release_id', 512).notNullable();
        table.string('policy_version', 128).notNullable();
        table.string('model_settings_hash', 64).notNullable();
        table.text('result_json').notNullable();
        table.timestamp('created_at').defaultTo(db.fn.now());
        table.timestamp('updated_at').defaultTo(db.fn.now());
      });
    }

    const hasContractVersionsTable = await db.schema.hasTable('contract_versions');
    if (!hasContractVersionsTable) {
      console.log('[DB Init] Creating new `contract_versions` table...');
      await db.schema.createTable('contract_versions', (table) => {
        table.increments('id').primary();
        table.integer('contract_id').unsigned().notNullable().references('id').inTable('contracts').onDelete('CASCADE');
        table.integer('user_id').unsigned().references('id').inTable('users').onDelete('SET NULL');
        table.integer('version_no').notNullable();
        table.string('source_action').notNullable();
        table.string('storage_path');
        table.text('plain_text');
        table.timestamps(true, true);
        table.index(['contract_id', 'version_no']);
      });
    }
    await ensureColumn('contract_versions', 'oss_key', (table) => table.text('oss_key'));
    await ensureColumn('contract_versions', 'oss_sha256', (table) => table.string('oss_sha256', 64));
    await ensureColumn('contract_versions', 'parent_version_id', (table) => table.integer('parent_version_id').unsigned().references('id').inTable('contract_versions').onDelete('SET NULL').index());
    await ensureColumn('contract_versions', 'document_view', (table) => table.string('document_view', 32));
    await ensureColumn('contract_versions', 'source_party', (table) => table.string('source_party', 32));
    await ensureColumn('contract_versions', 'content_sha256', (table) => table.string('content_sha256', 64));

    // Refuse to hide legacy corruption behind an index creation failure. The named
    // unique index is idempotent and becomes the final concurrency guard after the
    // contract-level write lock used by the version service.
    const duplicateContractVersions = await db('contract_versions')
      .select('contract_id', 'version_no')
      .count({ duplicate_count: '*' })
      .groupBy('contract_id', 'version_no')
      .havingRaw('COUNT(*) > 1')
      .limit(10);
    if (duplicateContractVersions.length > 0) {
      throw new Error(`CONTRACT_VERSION_DUPLICATES:${JSON.stringify(duplicateContractVersions)}`);
    }
    await db.raw([
      'CREATE UNIQUE INDEX IF NOT EXISTS contract_versions_contract_version_no_uidx',
      'ON contract_versions (contract_id, version_no)',
    ].join(' '));

    // 合同谈判轮次：仅做加法式扩展。旧合同在首次访问轮次接口时懒初始化为第 0 轮。
    const hasContractRoundsTable = await db.schema.hasTable('contract_rounds');
    if (!hasContractRoundsTable) {
      console.log('[DB Init] Creating new `contract_rounds` table...');
      await db.schema.createTable('contract_rounds', (table) => {
        table.increments('id').primary();
        table.integer('contract_id').unsigned().notNullable().references('id').inTable('contracts').onDelete('CASCADE');
        table.integer('round_no').notNullable();
        table.integer('parent_round_id').unsigned().references('id').inTable('contract_rounds').onDelete('SET NULL');
        table.integer('base_version_id').unsigned().references('id').inTable('contract_versions').onDelete('SET NULL');
        table.integer('working_version_id').unsigned().references('id').inTable('contract_versions').onDelete('SET NULL');
        table.string('source_party', 32).notNullable().defaultTo('system');
        table.string('baseline_view', 32).notNullable().defaultTo('proposed');
        table.string('status', 32).notNullable().defaultTo('draft');
        table.integer('created_by').unsigned().references('id').inTable('users').onDelete('SET NULL');
        table.timestamp('frozen_at');
        table.timestamps(true, true);
        table.unique(['contract_id', 'round_no']);
        table.index(['contract_id', 'status']);
      });
    }
    await ensureColumn('contract_versions', 'round_id', (table) => table.integer('round_id').unsigned().references('id').inTable('contract_rounds').onDelete('SET NULL').index());

    // 稳定条款身份：定位字段独立于 DOCX 书签，书签仅保留为可重建的界面导航信息。
    const hasContractClausesTable = await db.schema.hasTable('contract_clauses');
    if (!hasContractClausesTable) {
      console.log('[DB Init] Creating new `contract_clauses` table...');
      await db.schema.createTable('contract_clauses', (table) => {
        table.increments('id').primary();
        table.integer('contract_id').unsigned().notNullable().references('id').inTable('contracts').onDelete('CASCADE');
        table.string('clause_key', 128).notNullable();
        table.string('normalized_clause_no', 128);
        table.text('heading_path');
        table.string('text_hash', 64);
        table.string('structure_fingerprint', 64);
        table.jsonb('metadata').notNullable().defaultTo('{}');
        table.timestamps(true, true);
        table.unique(['contract_id', 'clause_key']);
        table.index(['contract_id', 'normalized_clause_no']);
      });
    }

    // 条款修订账本：DOCX 只承载当前轮红线，完整 supersedes/base 链保存在数据库中。
    const hasClauseRevisionsTable = await db.schema.hasTable('clause_revisions');
    if (!hasClauseRevisionsTable) {
      console.log('[DB Init] Creating new `clause_revisions` table...');
      await db.schema.createTable('clause_revisions', (table) => {
        table.increments('id').primary();
        table.integer('contract_id').unsigned().notNullable().references('id').inTable('contracts').onDelete('CASCADE');
        table.integer('round_id').unsigned().notNullable().references('id').inTable('contract_rounds').onDelete('CASCADE');
        table.integer('clause_id').unsigned().notNullable().references('id').inTable('contract_clauses').onDelete('CASCADE');
        table.integer('base_revision_id').unsigned().references('id').inTable('clause_revisions').onDelete('SET NULL');
        table.integer('supersedes_revision_id').unsigned().references('id').inTable('clause_revisions').onDelete('SET NULL');
        table.integer('version_id').unsigned().references('id').inTable('contract_versions').onDelete('SET NULL');
        table.string('revision_key', 128).notNullable();
        table.text('before_text').notNullable();
        table.text('after_text').notNullable();
        table.string('before_hash', 64);
        table.string('after_hash', 64);
        table.string('author_type', 32).notNullable().defaultTo('user');
        table.string('author_name', 256);
        table.string('source_party', 32).notNullable().defaultTo('thinkpark');
        table.string('source_issue_id', 128);
        table.string('status', 32).notNullable().defaultTo('pending');
        table.jsonb('ooxml_revision_ids').notNullable().defaultTo('[]');
        table.jsonb('metadata').notNullable().defaultTo('{}');
        table.timestamps(true, true);
        table.unique(['contract_id', 'revision_key']);
        table.index(['round_id', 'clause_id', 'status']);
      });
    }

    // 增量审查运行记录：只做扩展式迁移，旧 analysis_result.incremental_reviews 继续保留。
    const hasReviewRunsTable = await db.schema.hasTable('review_runs');
    if (!hasReviewRunsTable) {
      console.log('[DB Init] Creating new `review_runs` table...');
      await db.schema.createTable('review_runs', (table) => {
        table.increments('id').primary();
        table.string('run_key', 64).notNullable().unique();
        table.integer('contract_id').unsigned().notNullable().references('id').inTable('contracts').onDelete('CASCADE');
        table.integer('user_id').unsigned().references('id').inTable('users').onDelete('SET NULL');
        table.integer('from_version_no');
        table.string('status', 32).notNullable().defaultTo('completed');
        table.jsonb('diff_summary').notNullable().defaultTo('{}');
        table.timestamp('reviewed_at').notNullable().defaultTo(db.fn.now());
        table.timestamps(true, true);
        table.index(['contract_id', 'reviewed_at']);
      });
    }

    // 稳定风险账本：fingerprint 在合同内唯一，payload 兼容现有 dispute_points 字段。
    const hasReviewIssuesTable = await db.schema.hasTable('review_issues');
    if (!hasReviewIssuesTable) {
      console.log('[DB Init] Creating new `review_issues` table...');
      await db.schema.createTable('review_issues', (table) => {
        table.increments('id').primary();
        table.string('issue_key', 64).notNullable().unique();
        table.integer('contract_id').unsigned().notNullable().references('id').inTable('contracts').onDelete('CASCADE');
        table.string('fingerprint', 64).notNullable();
        table.string('clause_id', 128);
        table.string('status', 32).notNullable().defaultTo('open');
        table.string('title', 512);
        table.text('original_clause');
        table.jsonb('payload').notNullable().defaultTo('{}');
        table.integer('first_seen_run_id').unsigned().references('id').inTable('review_runs').onDelete('SET NULL');
        table.integer('last_seen_run_id').unsigned().references('id').inTable('review_runs').onDelete('SET NULL');
        table.timestamp('resolved_at');
        table.timestamps(true, true);
        table.unique(['contract_id', 'fingerprint']);
        table.index(['contract_id', 'status']);
      });
    }

    const hasContractGroupsTable = await db.schema.hasTable('contract_groups');
    if (!hasContractGroupsTable) {
      console.log('[DB Init] Creating new `contract_groups` table...');
      await db.schema.createTable('contract_groups', (table) => {
        table.increments('id').primary();
        table.integer('user_id').unsigned().references('id').inTable('users').onDelete('CASCADE');
        table.string('name').notNullable();
        table.text('analysis_result');
        table.string('status');
        table.timestamps(true, true);
      });
    }
    await ensureColumn('contract_groups', 'analysis_result', (table) => table.text('analysis_result'));
    await ensureColumn('contract_groups', 'status', (table) => table.string('status'));

    const hasQaHistoryTable = await db.schema.hasTable('qa_history');
    if (!hasQaHistoryTable) {
        console.log('[DB Init] Creating new `qa_history` table...');
        await db.schema.createTable('qa_history', (table) => {
            table.increments('id').primary();
            table.string('session_id').notNullable().index();
            table.string('role').notNullable();
            table.text('content').notNullable();
            table.integer('contract_id').unsigned().references('id').inTable('contracts').onDelete('SET NULL');
            table.timestamps(true, true);
        });
        console.log('[DB Init] New `qa_history` table created successfully.');
    }
    await ensureColumn('qa_history', 'user_id', (table) => table.integer('user_id').unsigned().references('id').inTable('users').onDelete('CASCADE').index());

    const hasFocusedReviewsTable = await db.schema.hasTable('focused_reviews');
    if (!hasFocusedReviewsTable) {
        console.log('[DB Init] Creating new `focused_reviews` table...');
        await db.schema.createTable('focused_reviews', (table) => {
            table.increments('id').primary();
            table.integer('contract_id').unsigned().notNullable().references('id').inTable('contracts').onDelete('CASCADE');
            table.integer('user_id').unsigned().references('id').inTable('users').onDelete('SET NULL');
            table.text('source_text').notNullable();
            table.string('question');
            table.string('perspective');
            table.string('contract_type');
            table.string('template_id');
            table.text('result').notNullable(); // JSON string of the focused review result
            table.timestamps(true, true);
            table.index(['contract_id', 'created_at']);
        });
        console.log('[DB Init] New `focused_reviews` table created successfully.');
    }

    // 法律版本管理表(P0 法律时效性监控):记录每部法律的所有版本时间线
    const hasLawVersionsTable = await db.schema.hasTable('law_versions');
    if (!hasLawVersionsTable) {
        console.log('[DB Init] Creating new `law_versions` table...');
        await db.schema.createTable('law_versions', (table) => {
            table.increments('id').primary();
            table.string('title').notNullable();               // 法律名称
            table.string('version_label');                     // 版本标识(如 2020版 / 修正版)
            table.date('effective_date');                      // 施行日期
            table.integer('superseded_by');                    // 被替代关系:指向新版本 id
            table.string('status').defaultTo('现行');           // 现行 / 已修订 / 已废止
            table.text('source_url');                          // 源 URL
            table.text('raw_markdown');                        // 原始 Markdown
            table.timestamp('synced_at').defaultTo(db.fn.now()); // 同步时间
            table.unique(['title', 'version_label']);
        });
        console.log('[DB Init] New `law_versions` table created successfully.');
    }

    // 行业标准条款库表(P3 4.3):存储用户/公共标准条款,审查时自动对比
    // embedding 不在此表存,而是通过 vectorStore 入库到 vector_documents 表(source_type='standard_clause')
    const hasStandardClausesTable = await db.schema.hasTable('standard_clauses');
    if (!hasStandardClausesTable) {
        console.log('[DB Init] Creating new `standard_clauses` table...');
        await db.schema.createTable('standard_clauses', (table) => {
            table.increments('id').primary();
            table.string('category').notNullable();            // confidentiality/breach/ip/dispute/force_majeure/...
            table.string('title');                             // 条款标题
            table.text('clause_text').notNullable();           // 条款正文
            table.string('industry');                          // 互联网/制造业/央企/通用
            table.string('owner_type').defaultTo('private');   // private/public
            table.integer('owner_user_id');                    // private 时记录 owner
            table.jsonb('applicable_contract_types');          // ["service","nda",...]
            table.integer('version').defaultTo(1);             // 版本号
            table.jsonb('metadata');                           // 扩展元数据
            table.timestamp('created_at').defaultTo(db.fn.now());
            table.timestamp('updated_at').defaultTo(db.fn.now());
        });
        console.log('[DB Init] New `standard_clauses` table created successfully.');
    }

    // 审查模板管理表(P1 Task 3):存储审查模板的在线管理数据,支持 CRUD 与版本快照
    const hasReviewTemplatesTable = await db.schema.hasTable('review_templates');
    if (!hasReviewTemplatesTable) {
        console.log('[DB Init] Creating new `review_templates` table...');
        await db.schema.createTable('review_templates', (table) => {
            table.string('id', 64).primary();
            table.string('name', 128).notNullable();
            table.jsonb('contract_type_keywords').notNullable();
            table.jsonb('review_points').notNullable();
            table.jsonb('core_purposes').notNullable();
            table.jsonb('report_sections').notNullable();
            table.jsonb('prompt_rules').notNullable();
            table.text('typical_description');
            table.text('typical_description_embedding'); // 存 JSON 数组字符串,用于语义匹配
            table.boolean('is_active').defaultTo(true);
            table.boolean('is_system').defaultTo(false); // 系统模板(seed 导入)不可删除
            table.timestamp('created_at').defaultTo(db.fn.now());
            table.timestamp('updated_at').defaultTo(db.fn.now());
        });
        console.log('[DB Init] New `review_templates` table created successfully.');
    }

    // 模板版本快照表(P1 Task 3):每次编辑前写入当前状态快照,支持回滚
    const hasTemplateVersionsTable = await db.schema.hasTable('template_versions');
    if (!hasTemplateVersionsTable) {
        console.log('[DB Init] Creating new `template_versions` table...');
        await db.schema.createTable('template_versions', (table) => {
            table.increments('id').primary();
            table.string('template_id', 64).notNullable();
            table.integer('version').notNullable();
            table.jsonb('snapshot').notNullable(); // 编辑前的完整模板快照
            table.string('changed_by', 64);
            table.timestamp('created_at').defaultTo(db.fn.now());
            table.unique(['template_id', 'version']);
        });
        console.log('[DB Init] New `template_versions` table created successfully.');
    }

    const hasKnowledgeApprovalAuditTable = await db.schema.hasTable('knowledge_approval_audit');
    if (!hasKnowledgeApprovalAuditTable) {
        console.log('[DB Init] Creating new `knowledge_approval_audit` table...');
        await db.schema.createTable('knowledge_approval_audit', (table) => {
            table.increments('id').primary();
            table.string('candidate_source_id', 512).notNullable().index();
            table.string('candidate_source_type', 64).notNullable();
            table.string('decision', 32).notNullable();
            table.integer('reviewer_user_id').unsigned().references('id').inTable('users').onDelete('SET NULL');
            table.string('reviewer_username', 128);
            table.string('reviewer_role', 64);
            table.text('review_note');
            table.jsonb('readiness_snapshot');
            table.string('promoted_source_id', 512);
            table.timestamp('created_at').defaultTo(db.fn.now());
        });
    }

    await ensureVectorStore();
    console.log('[DB Init] Vector store tables created. Vector index will be seeded in background after server.listen.');

    // 法律时效性字段扩展:为 vector_documents 表追加 law_status/superseded_by/effective_date
    // 旧数据 law_status 默认 '现行',不破坏现有检索;此处 ensureColumn 幂等,与 vectorStore.js 内部 addColumn 互为兜底
    await ensureColumn('vector_documents', 'law_status', (table) => table.string('law_status').defaultTo('现行'));
    await ensureColumn('vector_documents', 'superseded_by', (table) => table.string('superseded_by'));
    await ensureColumn('vector_documents', 'effective_date', (table) => table.date('effective_date'));

  } catch (error) {
    fatalError = error;
    console.error("[DB Init] FATAL: Failed to rebuild database schema:", error);
  } finally {
    if (schemaLockConnection) {
      try {
        await db.raw('SELECT pg_advisory_unlock(?)', [SCHEMA_ADVISORY_LOCK_ID]).connection(schemaLockConnection);
      } catch (unlockError) {
        fatalError ||= unlockError;
        console.error('[DB Init] FATAL: Failed to release schema advisory lock:', unlockError);
      } finally {
        await db.client.releaseConnection(schemaLockConnection);
      }
    }
  }
  if (fatalError) process.exit(1); // Release the session lock before terminating.
}

// Rename the exported function for clarity
module.exports = resetAndRebuildDatabase; 
