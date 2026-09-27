const CREDENTIAL_FIELD = /^(?:x)?(?:auth(?:entication|orization)?(?:header|headers|info|data|value|key|params|scheme)?|bearer|secret(?:key)?|(?:access|refresh|id)?token|apikey|password|credentials?|cookies?|session(?:id|key|token)?|accesskey|client(?:id|secret))$/i;

export function isCredentialFieldName(value: string): boolean {
  const compact = value.replace(/[_-]/g, '');
  return CREDENTIAL_FIELD.test(compact);
}

/** Whole keys, not substrings: endPoints and salesTrendPoints are business data. */
export function isSensitiveKey(key: string): boolean {
  return isCredentialFieldName(key) || key.toLowerCase() === 'endpoint' || key.toLowerCase() === 'headers';
}

export function redactCredentialAssignments(value: string): string {
  return value.replace(
    /(^|[?&\s{,])(["']?)([A-Za-z][A-Za-z0-9_-]*)\2\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^\s&,;}]+)/gi,
    (match, prefix: string, _quote: string, key: string) => (
      isCredentialFieldName(key) ? `${prefix}[REDACTED]` : match
    ),
  );
}
