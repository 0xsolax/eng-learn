import { z } from 'zod'

const ADMIN_USERNAME_PATTERN = /^[A-Za-z0-9._+@-]+$/
const NON_VISIBLE_CHARACTER_PATTERN = /[\p{C}\p{Zl}\p{Zp}]/u

const adminDisplayNameSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !NON_VISIBLE_CHARACTER_PATTERN.test(value), {
    message: 'Display name must contain only visible characters',
  })
  .refine((value) => Array.from(value).length <= 64, {
    message: 'Display name must contain at most 64 Unicode code points',
  })

export const adminLoginRequestSchema = z
  .object({
    username: z
      .string()
      .trim()
      .min(3)
      .max(64)
      .regex(ADMIN_USERNAME_PATTERN)
      .transform((username) => username.toLocaleLowerCase('en-US')),
    password: z.string().min(1).superRefine((password, context) => {
      if (Array.from(password).length > 128) {
        context.addIssue({
          code: 'too_big',
          maximum: 128,
          origin: 'string',
          inclusive: true,
          message: 'Password must contain at most 128 Unicode code points',
        })
      }
    }),
  })
  .strict()

export const adminSessionSourceSchema = z.enum([
  'cloudflare_access',
  'application_session',
  'service_token',
])

export const adminSessionSchema = z
  .object({
    id: z.string().trim().min(1),
    source: adminSessionSourceSchema,
    displayName: adminDisplayNameSchema,
    email: z.email().optional(),
  })
  .strict()

export const adminLogoutResultSchema = z
  .object({
    loggedOut: z.literal(true),
  })
  .strict()

export type AdminLoginRequest = z.input<typeof adminLoginRequestSchema>
export type AdminSessionDto = z.infer<typeof adminSessionSchema>
export type AdminSessionSource = z.infer<typeof adminSessionSourceSchema>
