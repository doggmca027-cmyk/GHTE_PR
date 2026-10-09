// The sign-up kill switch (platform_settings.global_signups_enabled), as a decision a test can read.
//
// Existing customers always get in: closing the door to NEWCOMERS during an attack must not lock out the people who already have
// a balance. A newcomer gets in only when the switch is explicitly on; if it cannot be read, the door stays closed (fail closed).

export type SignupDecision = 'allow' | 'paused'

export function signupGate(userExists: boolean, switchOn: boolean | null | undefined): SignupDecision {
  if (userExists) return 'allow'
  return switchOn === true ? 'allow' : 'paused'
}
