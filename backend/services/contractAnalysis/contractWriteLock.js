const db = require('../../database');

const CONTRACT_EDIT_LOCK_NAMESPACE = 742391105;
const activeContractEdits = new Set();
let activeDatabaseEditLocks = 0;

const capacityError = () => {
    const error = new Error('DOCUMENT_EDIT_CAPACITY');
    error.status = 503;
    return error;
};

const acquireContractWriteLock = async (contractId) => {
    const key = String(contractId);
    if (activeContractEdits.has(key)) {
        const error = new Error('DOCUMENT_EDIT_IN_PROGRESS');
        error.status = 409;
        throw error;
    }
    const poolMax = Number(db.client.pool?.max || process.env.DB_POOL_MAX || 10);
    const maxEditLocks = Math.max(1, Math.floor((poolMax - 1) / 2));
    if (activeDatabaseEditLocks >= maxEditLocks) throw capacityError();

    activeContractEdits.add(key);
    activeDatabaseEditLocks += 1;
    let connection = null;
    let locked = false;
    try {
        connection = await db.client.acquireConnection();
        const response = await db.raw(
            'SELECT pg_try_advisory_lock(?, ?) AS locked',
            [CONTRACT_EDIT_LOCK_NAMESPACE, Number(contractId)],
        ).connection(connection);
        locked = Boolean(response?.rows?.[0]?.locked);
        if (!locked) {
            const error = new Error('DOCUMENT_EDIT_IN_PROGRESS');
            error.status = 409;
            throw error;
        }
        return async () => {
            try {
                const response = await db.raw(
                    'SELECT pg_advisory_unlock(?, ?) AS unlocked',
                    [CONTRACT_EDIT_LOCK_NAMESPACE, Number(contractId)],
                ).connection(connection);
                if (!response?.rows?.[0]?.unlocked) {
                    console.error('[Contract Write Lock] PostgreSQL reported an unowned advisory lock', { contractId });
                    await db.client.destroyRawConnection(connection);
                    connection = null;
                }
            } catch (error) {
                console.error('[Contract Write Lock] Failed to release advisory lock:', error);
                if (connection) await db.client.destroyRawConnection(connection).catch(() => {});
                connection = null;
            } finally {
                if (connection) await db.client.releaseConnection(connection);
                activeDatabaseEditLocks = Math.max(0, activeDatabaseEditLocks - 1);
                activeContractEdits.delete(key);
            }
        };
    } catch (error) {
        if (!locked && connection) await db.client.releaseConnection(connection);
        activeDatabaseEditLocks = Math.max(0, activeDatabaseEditLocks - 1);
        activeContractEdits.delete(key);
        throw error;
    }
};

module.exports = { acquireContractWriteLock };
