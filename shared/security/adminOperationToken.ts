export const ADMIN_OPERATION_TOKEN_PATTERN = /^[0-9a-f]{64}$/u

type CredentialBrand<Name extends string> = string & {
  readonly __credentialBrand: Name
}

export type RawAdminOperationToken = CredentialBrand<'raw-admin-operation-token'>
export type AdminOperationKind =
  | 'create_course'
  | 'create_source'
  | 'reset_course_progress'
  | 'rotate_access_code'
  | 'update_learner_login'

export const parseAdminOperationToken = (
  value: string,
): RawAdminOperationToken | undefined =>
  ADMIN_OPERATION_TOKEN_PATTERN.test(value)
    ? (value as RawAdminOperationToken)
    : undefined

export const generateAdminOperationToken = (): RawAdminOperationToken => {
  const values = new Uint8Array(32)
  crypto.getRandomValues(values)

  return Array.from(values, (value) => value.toString(16).padStart(2, '0')).join(
    '',
  ) as RawAdminOperationToken
}
