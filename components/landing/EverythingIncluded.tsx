// Server component, no JS shipped for this section.
// The full list of what a club gets, grouped by job. Every line names
// something that exists in the product today. Three things are left out on
// purpose because they are not switched on: card payments by members, emails
// to members, and push notifications.

const GROUPS = [
  {
    title: "Timetable and classes",
    items: [
      "Week and day views, split by mat or by time",
      "Class colours, categories and levels",
      "More than one mat and more than one location",
      "Cancel one session without touching the rest of the week",
    ],
  },
  {
    title: "Check-in and attendance",
    items: [
      "A tablet at the door: pick the class, tap your name",
      "Coaches tick names or scan member cards",
      "Members can check in from their own phone, if you allow it",
      "A record of every check-in and who marked it",
    ],
  },
  {
    title: "Belts and promotions",
    items: [
      "Your own belt systems with stripes, or start from a preset",
      "Minimum classes and months for each belt",
      "A list of members who are ready for promotion",
      "Members see their own belt, stripes and history",
    ],
  },
  {
    title: "Members and families",
    items: [
      "Profiles with contact details, emergency contact and medical notes",
      "Waivers signed on a phone or tablet",
      "Children linked to a parent or guardian",
      "Put a membership on hold, and archive or restore a member",
    ],
  },
  {
    title: "Plans and money",
    items: [
      "Membership plans with a class allowance",
      "Class packs",
      "Record payments taken by cash or bank transfer",
      "Printable member cards",
    ],
    note: "Paying by card online is not available yet.",
  },
  {
    title: "Running the club",
    items: [
      "Separate sign-ins for owners, managers and coaches",
      "Two-step sign-in for staff",
      "An activity log of who changed what, with undo",
      "Reports on attendance and on members who have stopped coming, with export",
    ],
  },
  {
    title: "Your members' app",
    items: [
      "Your club's name, logo and colours",
      "Adds to a phone's home screen like an app",
      "Timetable, progress and announcements",
      "A club leaderboard that members can opt out of",
    ],
  },
  {
    title: "Moving in",
    items: [
      "We import your members from the system you use now",
      "Attendance history comes across too",
      "A short link that takes members straight to your club",
      "Set up with you, not left to you",
    ],
  },
] as const;

export function EverythingIncluded() {
  return (
    <section id="everything" className="land-rule">
      <div className="max-w-7xl mx-auto px-6 lg:px-10 py-20 lg:py-28">
        <h2 className="land-display text-4xl sm:text-5xl mb-4">Everything included</h2>
        <p className="land-muted text-lg max-w-2xl mb-12">
          The full list, grouped by the job it does.
        </p>

        <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
          {GROUPS.map((group) => (
            <li key={group.title} className="land-card p-6">
              <h3 className="land-display text-xl mb-4">{group.title}</h3>
              <ul className="land-list flex flex-col gap-2.5">
                {group.items.map((item) => (
                  <li key={item} className="land-muted text-sm leading-relaxed">
                    {item}
                  </li>
                ))}
              </ul>
              {"note" in group && <p className="land-faint text-sm mt-4">{group.note}</p>}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
