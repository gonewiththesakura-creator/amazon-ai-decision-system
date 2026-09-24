const CREDENTIAL_FIELD = /(?:^|[_-])(?:x[_-]?)?auth(?:entication|orization)?(?:$|[_-])|bearer|secret|token|api[_-]?key|password|credential|cookie|session|access[_-]?key|client[_-]?(?:id|secret)/i;

export function isCredentialFieldName(value: string): boolean {
  const compact = value.replace(/[_-]/g, '');
  return /^(?:x)?auth(?:entication|orization)?(?:header|headers|info|data|value|key|params|scheme)$/i
    .test(compact) || CREDENTIAL_FIELD.test(value);
}

export function redactCredentialAssignments(value: string): string {
  return value.replace(
    /(^|[?&\s{,])(["']?)([A-Za-z][A-Za-z0-9_-]*)\2\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^\s&,;}]+)/gi,
    (match, prefix: string, _quote: string, key: string) => (
      isCredentialFieldName(key) ? `${prefix}[REDACTED]` : match
    ),
  );
}
