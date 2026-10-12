/**
 * Used by the Sessions and Archive tabs as the `projectId` of their bulk
 * selection (see SidebarSessionSelection): one selection exists at a time, and
 * these keep it from being mistaken for a project's. Project ids are UUIDs, so
 * they cannot collide.
 */
export const RECENT_SESSIONS_SELECTION_SCOPE = 'sidebar:recent';
export const ARCHIVED_SESSIONS_SELECTION_SCOPE = 'sidebar:archived';
