export const resolveRecommendedPerspective = (preAnalysisData = {}) => {
    const party = preAnalysisData.party_identification || preAnalysisData.partyIdentification || {};
    const role = party.our_role || preAnalysisData.our_role || preAnalysisData.detected_role || '';
    const roleLabel = party.role_label || preAnalysisData.role_label
        || (role === 'party_a' ? '甲方' : role === 'party_b' ? '乙方' : '');
    const ourParty = party.our_party || preAnalysisData.our_party || preAnalysisData.detected_party || '';
    if (roleLabel && ourParty) return `${roleLabel}（${ourParty}）`;
    return String(preAnalysisData.suggested_user_perspective || roleLabel || '').trim();
};

