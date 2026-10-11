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
      data-workspace-shell
      className="fixed inset-0 flex bg-background"
      // Sized to what is on screen: the area above the keyboard when it is up,
      // the whole screen in iOS home-screen apps (see useVisualViewportKeyboardOffset).
      // Positioned in the page rather than fixed: iPad home-screen apps report a
      // viewport 32pt shorter than the screen and clip fixed elements to it,
      // while ordinary page content still draws down to the screen's edge.
      style={{
        position: 'absolute',
        top: 'var(--app-offset-top, 0px)',
        bottom: 'auto',
        height: 'var(--app-height, 100%)',
      }}
    >
      <ProjectEffects navigate={navigate} />
      <ProjectSidebarRegion />

      {/* The columns run up behind the iOS status bar and start their content
          below it (--shell-top-inset), so its band shows the app, not a gap. */}
      <div className="flex min-w-0 flex-1 flex-col" style={{ paddingTop: 'var(--shell-top-inset, 0px)' }}>
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
