# Operator: when the owner's new login address is already taken

Added 12 Oct 2026. For whoever runs the operator console (`/admin`) — today that is the business owner. It explains what
to do when a club owner should sign in with an address that another record in the same club already uses.

Related pages: [OWNER-LOGIN-EMAIL-CHANGE.md](OWNER-LOGIN-EMAIL-CHANGE.md) (what "provisional" means),
[SUPPORT-IDENTITY-VERIFICATION.md](SUPPORT-IDENTITY-VERIFICATION.md) (how to verify a caller) and
[ACCOUNT-EDITING.md](ACCOUNT-EDITING.md) (who may edit which field).

## Two kinds of record

Every holder in the conflict panel carries one of two labels. Read the label before you press anything.

- **Club sign-in account** ("Owner account" or "Staff account (manager)", "(coach)", "(admin)"). A person who signs in to
  the club's back office, the dashboard, to run the club. Its address is a login address.
- **Member record** ("Member (gym customer)"). A customer of the club: membership, attendance and payments. Its address
  is a contact address. Some members can also sign in to the member app.

A member record and a sign-in account are different rows, even when they belong to the same person. Nothing in this
procedure merges or deletes either of them.

## Where to start

1. Open the club in `/admin` and find the card **Owner's sign-in email (back office)**.
2. Press **Change login email**, type the address the owner should use, and press **Check address**.
3. If the address is free, the card says "Free in this club". Use the normal change form on the same card; this page does
   not apply.
4. If the address is taken, the **Resolve conflict** panel opens. It shows the club, the owner, the address, and every
   record that holds it. Then follow the case that matches.

## Phone the club back before you act

The panel asks you to tick "I verified independently, with the club, whose address this is…" and to write how you
verified it. Do this properly every time.

- Phone the club back on the number you already hold for it, not a number given in the request. Ask the owner to confirm
  which address belongs to whom.
- A matching name proves nothing. Anyone can ask for an address to be moved, and a request by email or chat can come
  from someone pretending to be the owner. Moving an address can hand an account to whoever reads the new address, and
  it signs real people out. The call-back is the check that the request is genuine.
- Write the call-back in the note, for example "call-back to the club's number on file 12 Oct 14:05, owner confirmed
  Pat uses a personal address, ticket #123". The note goes into the audit log with every change.
- If you cannot reach the club on the number on file, stop. Do not act on the request.

## The three cases

### Case 1: a member record holds the address (often with the owner's own name)

This is the common one after an import. The owner was imported as a customer of their own gym, so a member record has
the same address and the same name as the owner. The panel shows **Member record**, "Member (gym customer)", and the
note "Same name as the owner, but this is a different record from the owner's sign-in account."

1. Tick the verification box and write how you verified it.
2. Press **Change this member's contact address**. Type the member's new contact address (ask the club for it on the
   call), check the reason, enter your authenticator code, and press **Change contact address**.
3. The panel checks the address again. When it says "The address is now free in this club", go to "Finish: change the
   owner" below.

What the button changes: only the member record's contact address. Its membership, payments, attendance, import
identity, guardian links and password stay as they are.

### Case 2: a staff account holds the address

A manager, coach or admin account signs in with the address. The panel shows **Club sign-in account** and, for example,
"Staff account (manager)".

1. Tick the verification box and write how you verified it. Also confirm on the call that the staff member knows their
   login address is about to change.
2. Press **Change this staff account's login address**. Type their new login address, check the reason, enter your
   authenticator code, and press **Change login address**.
3. When the panel says the address is free, finish with the owner as below.

What the button changes: only that staff account's login address. Their role, password and authenticator stay as they
are. Their new address is provisional (unverified), as for any address an operator types. The owner's account cannot be
moved this way: the owner's address changes only through the owner card.

### Case 3: two records hold the address (a legacy duplicate)

Older data can have the same address on two records, for example a member record and a coach's sign-in account. The
panel says "2 records in this club" and lists each one with its own label and its own move button.

1. Tick the verification box and write how you verified it. On the call, get a new address for every record listed.
2. Move each record in turn with its own button, using a new authenticator code each time. After each move the panel
   checks again and lists whatever still holds the address.
3. When nothing holds it any more, the panel says the address is free. Finish with the owner as below.

## Finish: change the owner

1. Press **Change the owner's login address**. Wait for a new authenticator code (each code works once), enter it, and
   press **Change login address**.
2. The panel shows **Conflict resolved** and lists each step: which record moved, the re-check, and the owner change.

What this changes: only the owner's login address. Same account, role, password and authenticator. The new address is
provisional until it is confirmed (see [OWNER-LOGIN-EMAIL-CHANGE.md](OWNER-LOGIN-EMAIL-CHANGE.md)).

Tell the owner on the same call that they will be signed out and must sign in again with the new address, their
password and their authenticator.

## Who gets signed out

| Record | Signed out? | Also |
|---|---|---|
| The owner | Yes, on every device. | Signs in with the new address, same password and authenticator. Reset codes and sign-in links for the old and new address in this club are cancelled. |
| A staff account you moved | Yes, on every device. | Signs in with their new address, same password and authenticator. Their outstanding reset codes and sign-in links in this club are cancelled. |
| A member who can sign in (has a password) | Yes, on every device. | Signs in with the new contact address. |
| A member with no password | Nothing to sign out of. | Any outstanding invite, sign-in or reset link for the old or new address in this club is cancelled. The club can send a fresh invite later. |
| Everyone else in the club | No. | Nothing about them changes. |

Every change writes an audit row with your operator id and your reason. The owner sees it in their Activity log.

## If something goes wrong part-way

The moves and the owner change are separate steps. If a move succeeded and the owner change did not, the panel says
"Step 1 done, step 2 not done" and nothing is undone.

- **The response was lost** (network drop, timeout). The dialog says the result is not known and offers **Re-send the
  same confirmation**. Press it. It sends the same confirmation again; if the change had already been made, the answer is
  "already applied" and nothing changes twice. Do not start a new change with a new code instead.
- **You reloaded the page or closed the panel after a move.** In the same browser tab, the page remembers where you were
  and reopens the panel at the owner step after checking the address again. Press **Change the owner's login address**
  and continue.
- **You closed the tab.** The card says a resolution was interrupted after step 1. Press **Change login email**, type the
  owner's new address again and press **Check address**. If it is free, change the owner with the normal form on the card.
  If it is still held, the panel lists what still holds it.
- **"This record changed since you checked it"** or **"already held by someone else"**. Someone edited the record or the
  address in the meantime. Nothing was changed. Press **Check address** again and start from what the panel now shows.
- **"Your authenticator code was not accepted"**. Codes work once and only for a short time. Wait for the next code and
  try again. After five confirmations in ten minutes you must wait a few minutes.

Never fix a conflict by editing the database by hand: the panel's checks, locks and audit rows are what make the change
safe and traceable.
