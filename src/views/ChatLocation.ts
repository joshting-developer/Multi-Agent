/** Secondary Sidebar contributions are supported from VS Code 1.106. */
export function chatLocation(version: string): { legacy: boolean; viewId: string; containerId: string } {
  const [major = 0, minor = 0] = version.split('.').map(Number);
  const legacy = !(major > 1 || (major === 1 && minor >= 106));
  return legacy
    ? { legacy, viewId: 'multiAgent.chat', containerId: 'multiAgent' }
    : { legacy, viewId: 'multiAgent.chatSecondary', containerId: 'multiAgentChat' };
}
