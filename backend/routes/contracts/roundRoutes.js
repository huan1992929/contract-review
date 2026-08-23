/**
 * @file routes/contracts/roundRoutes.js
 * @brief 合同谈判轮次与不可变版本节点接口
 */
const { requireRequestUserId, findOwnedContract } = require('../../services/contractAnalysis/auth');
const {
    RevisionRoundError,
    ensureInitialRound,
    listRounds,
    listRoundVersions,
    createRound,
    freezeRound,
    createRoundVersion,
} = require('../../services/contractAnalysis/revisionRounds');

const handleRoundError = (res, error) => {
    if (error instanceof RevisionRoundError) {
        return res.status(error.status).json({
            error: error.message,
            code: error.code,
            ...(error.details && Object.keys(error.details).length > 0 ? { details: error.details } : {}),
        });
    }
    console.error('[Contract Rounds] Unexpected error:', error);
    return res.status(500).json({ error: '轮次操作失败。', code: 'ROUND_INTERNAL_ERROR' });
};

module.exports = function (router) {
    router.get('/:id/rounds', async (req, res) => {
        const userId = requireRequestUserId(req, res);
        if (!userId) return;
        const contract = await findOwnedContract(req.params.id, userId);
        if (!contract) return res.status(404).json({ error: 'Contract not found.' });
        try {
            await ensureInitialRound(contract, { userId });
            return res.json({ rounds: await listRounds(contract.id) });
        } catch (error) {
            return handleRoundError(res, error);
        }
    });

    router.post('/:id/rounds/initialize', async (req, res) => {
        const userId = requireRequestUserId(req, res);
        if (!userId) return;
        const contract = await findOwnedContract(req.params.id, userId);
        if (!contract) return res.status(404).json({ error: 'Contract not found.' });
        try {
            return res.json({ round: await ensureInitialRound(contract, { userId }) });
        } catch (error) {
            return handleRoundError(res, error);
        }
    });

    router.post('/:id/rounds', async (req, res) => {
        const userId = requireRequestUserId(req, res);
        if (!userId) return;
        const contract = await findOwnedContract(req.params.id, userId);
        if (!contract) return res.status(404).json({ error: 'Contract not found.' });
        try {
            const round = await createRound(contract, { ...req.body, userId });
            return res.status(201).json({ round });
        } catch (error) {
            return handleRoundError(res, error);
        }
    });

    router.post('/:id/rounds/:roundId/freeze', async (req, res) => {
        const userId = requireRequestUserId(req, res);
        if (!userId) return;
        const contract = await findOwnedContract(req.params.id, userId);
        if (!contract) return res.status(404).json({ error: 'Contract not found.' });
        try {
            const round = await freezeRound(contract.id, Number(req.params.roundId), req.body || {});
            return res.json({ round });
        } catch (error) {
            return handleRoundError(res, error);
        }
    });

    router.post('/:id/rounds/:roundId/versions', async (req, res) => {
        const userId = requireRequestUserId(req, res);
        if (!userId) return;
        const contract = await findOwnedContract(req.params.id, userId);
        if (!contract) return res.status(404).json({ error: 'Contract not found.' });
        try {
            const version = await createRoundVersion(contract, Number(req.params.roundId), req.body || {});
            return res.status(201).json({ version });
        } catch (error) {
            return handleRoundError(res, error);
        }
    });

    router.get('/:id/rounds/:roundId/versions', async (req, res) => {
        const userId = requireRequestUserId(req, res);
        if (!userId) return;
        const contract = await findOwnedContract(req.params.id, userId);
        if (!contract) return res.status(404).json({ error: 'Contract not found.' });
        try {
            const versions = await listRoundVersions(contract.id, Number(req.params.roundId));
            return res.json({ versions });
        } catch (error) {
            return handleRoundError(res, error);
        }
    });
};
