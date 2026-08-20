const fs = require('fs');
const path = require('path');

const mirrorContractFile = async (filePath, { owner, contractId, version }) => {
    const url = String(process.env.THINKPARK_STORAGE_GATEWAY_URL || '').trim();
    const integrationKey = String(process.env.THINKPARK_INTEGRATION_KEY || '').trim();
    if (!url || !integrationKey) {
        if (String(process.env.THINKPARK_STORAGE_REQUIRED || '').toLowerCase() === 'true') {
            throw new Error('THINKPARK_STORAGE_GATEWAY_NOT_CONFIGURED');
        }
        return { oss_key: null, sha256: null, size: null };
    }
    const data = await fs.promises.readFile(filePath);
    const form = new FormData();
    form.set('owner', String(owner));
    form.set('contract_id', String(contractId));
    form.set('version', String(version));
    form.set('file', new Blob([data]), path.basename(filePath));
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'X-Thinkpark-Contract-Review-Key': integrationKey },
        body: form,
        signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) throw new Error(`THINKPARK_STORAGE_MIRROR_FAILED:${response.status}`);
    return response.json();
};

module.exports = { mirrorContractFile };
