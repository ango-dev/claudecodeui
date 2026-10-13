import { createContext, useContext } from 'react';

import type { PendingPermissionRequest } from '@/shared/types';

export type PermissionContextValue = {
  pendingPermissionRequests: PendingPermissionRequest[];
  handlePermissionDecision: (
    requestIds: string | string[],
    decision: { allow?: boolean; message?: string; rememberEntry?: string | null; updatedInput?: unknown },
  ) => void;
  /** The newest plan's tool id in the open session: the only plan still answerable once its request is gone. */
  latestPlanToolId?: string | null;
  /** Claude is working in the open session, so an unanswered plan may still get its request. */
  isSessionBusy?: boolean;
  /** Answers a plan whose request is gone with a new message; `leavePlanMode` turns plan mode off first. */
  sendPlanFollowUp?: (text: string, leavePlanMode: boolean) => void;
};

const PermissionContext = createContext<PermissionContextValue | null>(null);

export function usePermission(): PermissionContextValue | null {
  return useContext(PermissionContext);
}

export default PermissionContext;
