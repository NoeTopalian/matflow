// Server component, no JS shipped for this section.
// Every card describes something a club can use today. Member payments by
// card are not listed: they are not switched on.

const FEATURES = [
  {
    title: "Timetable",
    body: "Build your week once. Classes that run at the same time sit side by side, by mat or by time, and members see the same timetable on their phone.",
  },
  {
    title: "Check-in at the door",
    body: "Put a tablet by the door and members tap their name as they arrive. Coaches can mark attendance for a class as well.",
  },
  {
    title: "Belts and stripes",
    body: "Every member's rank and stripes in one place, with the classes they have attended counted towards their next promotion.",
  },
  {
    title: "Members and reports",
    body: "Your member list, plans and attendance together, with reports that show who is training and who has stopped coming.",
  },
] as const;

export function FeaturesGrid() {
  return (
    <section id="features" className="land-rule">
      <div className="max-w-7xl mx-auto px-6 lg:px-10 py-20 lg:py-28">
        <h2 className="land-display text-4xl sm:text-5xl mb-4">What you get</h2>
        <p className="land-muted text-lg max-w-2xl mb-12">
          The four jobs a club does every day, in one place, under your club&apos;s own name, logo
          and colours.
        </p>

        <ul className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          {FEATURES.map(({ title, body }) => (
            <li key={title} className="land-card p-6 sm:p-8">
              <h3 className="land-display text-2xl sm:text-3xl mb-3">{title}</h3>
              <p className="land-muted text-base leading-relaxed">{body}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
