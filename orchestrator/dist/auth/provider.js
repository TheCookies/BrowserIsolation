"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ROLES = void 0;
exports.isRole = isRole;
exports.ROLES = ["user", "admin"];
function isRole(value) {
    return value === "user" || value === "admin";
}
//# sourceMappingURL=provider.js.map