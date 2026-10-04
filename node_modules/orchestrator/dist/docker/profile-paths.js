"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.profileContainerPath = profileContainerPath;
const neko_browsers_1 = require("../neko-browsers");
function profileContainerPath(browser) {
    const meta = (0, neko_browsers_1.getNekoBrowser)(browser);
    if (!meta)
        throw new Error(`Unknown browser ${browser}`);
    return meta.profilePath;
}
//# sourceMappingURL=profile-paths.js.map