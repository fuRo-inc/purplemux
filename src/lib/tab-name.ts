import type { TPanelType } from '@/types/terminal';

export const defaultTabNameForPanelType = (panelType?: TPanelType): string => {
  if (panelType === 'web-browser') return 'Web Browser';
  if (panelType === 'codex-chat') return 'Codex Chat';
  return '';
};

const legacyDefaultTabNameForPanelType = (panelType?: TPanelType): string => {
  if (panelType === 'agent-sessions') return 'Session List';
  return '';
};

export const resolveTabNameForPanelTypeChange = (
  name: string,
  fromPanelType: TPanelType | undefined,
  toPanelType: TPanelType | undefined,
): string => {
  const fromDefault = defaultTabNameForPanelType(fromPanelType);
  const legacyFromDefault = legacyDefaultTabNameForPanelType(fromPanelType);
  const toDefault = defaultTabNameForPanelType(toPanelType);
  const trimmed = name.trim();
  const isFromDefault =
    (fromDefault !== '' && trimmed === fromDefault) ||
    (legacyFromDefault !== '' && trimmed === legacyFromDefault);

  if (!trimmed && toDefault) return toDefault;
  if (isFromDefault && trimmed !== toDefault) return toDefault;
  return name;
};
