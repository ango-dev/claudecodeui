import { memo } from 'react';

import ProjectEffects from '@/modules/project-workspace/controllers/ProjectEffects';
import type { ProjectWorkspaceShellProps } from '@/shared/types';
import ProjectCommandPalette from '@/modules/project-workspace/ProjectCommandPalette';
import ProjectMainRegion from '@/modules/project-workspace/ProjectMainRegion';
import ProjectSidebarRegion from '@/modules/project-workspace/ProjectSidebarRegion';

/** Rendered by ProjectWorkspaceRoute to lay out the workspace sidebar, main region and global overlays. */
function ProjectWorkspaceShell({
  isMobile,
  ws,
  sendMessage,
  navigate,
}: ProjectWorkspaceShellProps) {
  return (
    <div
      className="fixed inset-0 flex bg-background"
      // Sized to what is on screen: the area above the keyboard when it is up,
      // the whole screen in iOS home-screen apps (see useVisualViewportKeyboardOffset).
      style={{
        top: 'calc(var(--app-offset-top, 0px) + var(--shell-top-inset, 0px))',
        bottom: 'auto',
        height: 'calc(var(--app-height, 100%) - var(--shell-top-inset, 0px))',
      }}
    >
      <ProjectEffects navigate={navigate} />
      <ProjectSidebarRegion />

      <div className="flex min-w-0 flex-1 flex-col">
        <ProjectMainRegion
          isMobile={isMobile}
          ws={ws}
          sendMessage={sendMessage}
          navigate={navigate}
        />
      </div>

      <ProjectCommandPalette />
    </div>
  );
}

export default memo(ProjectWorkspaceShell);
