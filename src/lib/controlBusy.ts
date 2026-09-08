export type ControlBusyAction = string;

export interface ControlBusyState {
  disabled: boolean;
  loading: boolean;
}

export function controlBusyState(
  activeAction: ControlBusyAction | null,
  action: ControlBusyAction,
): ControlBusyState {
  return {
    disabled: activeAction !== null,
    loading: activeAction === action,
  };
}
