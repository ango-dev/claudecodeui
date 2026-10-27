// settingsRoutes: used by the server entrypoint to mount protected application-settings endpoints.
// isVsCodeSessionListingEnabled: used by the providers module's Claude runtime to read "Show these sessions in VS Code".
// isQueuedMessageCombiningEnabled: used by the scheduled-messages dispatcher to read "Combine queued messages".
export { isQueuedMessageCombiningEnabled, isVsCodeSessionListingEnabled, settingsRoutes } from './settings.module.js';
