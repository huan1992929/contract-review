const USER_ID_KEY = 'user_id';

let currentUserId = localStorage.getItem(USER_ID_KEY);

// Kept as a compatibility shim for older composables. The authenticated
// session is now authoritative and hydrates the user id after login.
export const identifyUser = async () => {
    return getUserId();
};

export const setAuthenticatedUser = (user) => {
    currentUserId = user?.id ? String(user.id) : null;
    if (currentUserId) localStorage.setItem(USER_ID_KEY, currentUserId);
};

export const clearAuthenticatedUser = () => {
    currentUserId = null;
    localStorage.removeItem(USER_ID_KEY);
    localStorage.removeItem('review_session');
};

/**
 * Gets the current user's ID.
 * @returns {number|null} The current user's ID, or null if not identified.
 */
export const getUserId = () => {
    return currentUserId ? parseInt(currentUserId, 10) : null;
};
