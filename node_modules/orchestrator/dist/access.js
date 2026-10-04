"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.canAccessBrowserSession = canAccessBrowserSession;
function canAccessBrowserSession(user, session) {
    if (!user || !session)
        return false;
    if (user.role === "admin")
        return true;
    return session.ownerUsername === user.username;
}
//# sourceMappingURL=access.js.map