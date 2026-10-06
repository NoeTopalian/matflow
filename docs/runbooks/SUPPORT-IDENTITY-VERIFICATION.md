# Verifying a club owner before a support reset

Applies to every operator action that hands someone control of a club account: force password reset, owner 2FA reset,
member 2FA reset, ownership transfer, and starting a support (impersonation) session. The operator is the trust
boundary for these: the product cannot tell a real owner from someone pretending to be one. These actions also need a
fresh authenticator code from the operator (step-up), which proves who the OPERATOR is, not who the caller is.

## The rule

Act only on a request you have confirmed through a channel the club gave us before the request arrived.
Never act on an inbound-only request: not on the phone number that called you, the address that emailed you, a
WhatsApp or social message, or "I'm with the owner right now".

## How to verify

1. Look up the contact details already on file: the owner's account email, the club's contact email and phone
   (club settings), and anything recorded at onboarding.
2. Confirm by ONE of:
   - **Call back** on the number on file (not the number that called). Ask them to confirm the request and one detail
     only the club would know (for example the club's sign-up date, its membership count range, or the last payout).
   - **Email from the address on file**: you send a message to the owner's address on file describing the request;
     act only on the reply to that message.
3. If the details on file are themselves what is being changed or are unreachable (lost phone AND lost mailbox), stop.
   Escalate to Noe, ask for documentary proof (for example the club's company or trading details matching the billing
   record), and record what was accepted.
4. Ownership transfer additionally needs confirmation from the CURRENT owner, or, if they are gone, the documentary
   proof above.

## Record it

Put the verification in the action's reason field, which is written to the audit log. For example:
`Owner locked out, verified by call-back to number on file 6 Oct 14:05, ticket #123`.
Do not paste passwords, codes or identity documents into the reason.

## Handing over a temporary password

- Give it through the verified channel (the call-back, or a reply to the address on file). Never in the same message
  thread the request arrived on.
- It stops working after 72 hours and must be replaced at first sign-in. If it expires, issue a new one; there is no
  way to extend it.
- Tell the owner to expect it. A reset they did not ask for is a security event: they should contact us.

## When something is off

Pressure, urgency, a new phone number, a changed email, or a request to send the password somewhere else are reasons
to slow down, not to speed up. Refuse politely and verify through the details on file.
