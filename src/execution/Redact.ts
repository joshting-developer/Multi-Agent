// shortcut: 常見秘密格式的遮罩，完整的秘密掃描與日誌稽核在 MA-69。
const patterns: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\b(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi,
  /\b((?:api[_-]?key|[a-z_]*token|[a-z_]*secret|password|passwd)["']?\s*[:=]\s*["']?)[^\s"',}]{6,}/gi
];

/** 顯示或保存工具 IN／OUT 前先遮罩秘密，再截斷長度。 */
export function redact(text: string, limit: number): string {
  let value = text;
  for (const pattern of patterns) value = value.replace(pattern, (match, prefix?: string) => typeof prefix === 'string' && match.startsWith(prefix) ? `${prefix}[已遮罩]` : '[已遮罩]');
  return value.length > limit ? `${value.slice(0, limit)}\n…（已截斷 ${value.length - limit} 字）` : value;
}
