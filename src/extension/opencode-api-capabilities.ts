import { asRecord, isString } from '../shared/type-utils';
import type { UnknownRecord } from '../shared/type-utils';

export function getOpenCodeApiCapabilities<T>(value: T) {
  const spec = asRecord(value);
  const paths = asRecord(spec?.paths);
  const properties = (path: string) => {
    const operation = asRecord(asRecord(paths?.[path])?.patch);
    const body = asRecord(operation?.requestBody);
    const content = asRecord(body?.content);
    return requestProperties(asRecord(content?.['application/json'])?.schema, spec);
  };
  return {
    sessionArchiving: properties('/api/session/{sessionID}').has('archived'),
    savedPermissionEditing:
      properties('/api/permission/saved/{id}').has('action') &&
      properties('/api/permission/saved/{id}').has('resource'),
  };
}

function requestProperties<T>(value: T, spec: UnknownRecord | null, depth = 0): Set<string> {
  const schema = asRecord(value);
  if (!schema || depth > 8) return new Set();
  if (isString(schema.$ref) && schema.$ref.startsWith('#/components/schemas/')) {
    const name = schema.$ref
      .slice('#/components/schemas/'.length)
      .replaceAll('~1', '/')
      .replaceAll('~0', '~');
    return requestProperties(
      asRecord(asRecord(spec?.components)?.schemas)?.[name],
      spec,
      depth + 1
    );
  }
  const properties = new Set(Object.keys(asRecord(schema.properties) ?? {}));
  for (const key of ['allOf', 'anyOf', 'oneOf']) {
    const variants = schema[key];
    if (!Array.isArray(variants)) continue;
    for (const variant of variants) {
      for (const property of requestProperties(variant, spec, depth + 1)) properties.add(property);
    }
  }
  return properties;
}
