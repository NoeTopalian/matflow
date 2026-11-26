// Server component, no JS shipped for this section.
// Every feature describes something a club can use today, and is shown with
// the real screen. Member payments by card are not listed: they are not
// switched on.
//
// The pictures are of a made-up club on the test system: invented club name,
// invented people on example.test addresses, an invented week. No real club,
// person or timetable appears in them.

import Image, { type StaticImageData } from "next/image";
import timetableWeek from "@/components/landing/shots/timetable-week.webp";
import checkinKiosk from "@/components/landing/shots/checkin-kiosk.webp";
import memberProgress from "@/components/landing/shots/member-progress.webp";
import membersList from "@/components/landing/shots/members-list.webp";

type Feature = {
  title: string;
  body: string;
  shot: StaticImageData;
  width: number;
  height: number;
  alt: string;
  caption: string;
  /** A phone screen: shown narrow, never stretched to the column. */
  phone?: boolean;
};

const FEATURES: Feature[] = [
  {
    title: "Check-in at the door",
    body: "Put a tablet by the door and members tap their name as they arrive. Coaches can mark attendance for a class as well.",
    shot: checkinKiosk,
    width: 1400,
    height: 1088,
    alt: "The check-in screen on a tablet, under the club's name. It says Pick your class and lists today's classes with their times, from Morning Beginners at 06:30 to No-Gi at 19:00.",
    caption: "The tablet by the door.",
  },
  {
    title: "Belts and stripes",
    body: "Every member's rank and stripes in one place, with the classes they have attended counted towards their next promotion.",
    shot: memberProgress,
    width: 780,
    height: 1253,
    alt: "A member's Progress screen on their phone. It shows a blue belt with three of four stripes, the date the belt was tied on and by which coach, and the line Promotions are your coach's call.",
    caption: "What a member sees on their phone.",
    phone: true,
  },
  {
    title: "Members and reports",
    body: "Your member list, plans and attendance together, with reports that show who is training and who has stopped coming.",
    shot: membersList,
    width: 1600,
    height: 1177,
    alt: "The Members screen. Fourteen active members, none needing attention, then a list of members with their waiver marked Signed and the date of their last visit.",
    caption: "Your member list.",
  },
];

export function FeaturesGrid() {
  return (
    <section id="features" className="land-rule">
      <div className="max-w-7xl mx-auto px-6 lg:px-10 py-20 lg:py-28">
        <h2 className="land-display text-4xl sm:text-5xl mb-4">What you get</h2>
        <p className="land-muted text-lg max-w-2xl mb-14">
          The four jobs a club does every day, in one place, under your club&apos;s own name, logo
          and colours. These are the real screens, shown with an example club.
        </p>

        {/* Timetable: seven days need the full width. On a phone the picture
            keeps a readable width and scrolls sideways inside its own frame. */}
        <div className="mb-20 lg:mb-28">
          <h3 className="land-display text-3xl sm:text-4xl mb-3">Timetable</h3>
          <p className="land-muted text-base sm:text-lg leading-relaxed max-w-2xl mb-8">
            Build your week once. Classes that run at the same time sit side by side, by mat or by
            time, and members see the same timetable on their phone.
          </p>
          <figure>
            <div
              role="region"
              aria-label="Timetable picture, scrolls sideways"
              tabIndex={0}
              className="land-shot overflow-x-auto"
            >
              <Image
                src={timetableWeek}
                alt="A club's week in MatFlow.Studio. Each day is split into Mat 1 and Mat 2, with classes such as Beginners, Kickboxing, Kids and Open Mat. Thursday is today: two classes are marked live and two are marked next."
                width={2240}
                height={1057}
                sizes="(min-width: 1280px) 1200px, (min-width: 768px) 94vw, 760px"
                className="block w-full min-w-[47.5rem] h-auto"
              />
            </div>
            <figcaption className="land-faint text-sm mt-3">The week as your coaches see it.</figcaption>
          </figure>
        </div>

        {/* The other three: words on one side, the screen on the other, sides alternating. */}
        <ul className="flex flex-col gap-20 lg:gap-28">
          {FEATURES.map(({ title, body, shot, width, height, alt, caption, phone }, i) => (
            <li key={title} className="grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-14 items-center">
              <div className={`lg:col-span-5 ${i % 2 === 1 ? "lg:order-2" : ""}`}>
                <h3 className="land-display text-3xl sm:text-4xl mb-3">{title}</h3>
                <p className="land-muted text-base sm:text-lg leading-relaxed">{body}</p>
              </div>
              <figure className={`lg:col-span-7 ${i % 2 === 1 ? "lg:order-1" : ""}`}>
                <div className={`land-shot overflow-hidden ${phone ? "max-w-[20rem] mx-auto" : ""}`}>
                  <Image
                    src={shot}
                    alt={alt}
                    width={width}
                    height={height}
                    sizes={phone ? "320px" : "(min-width: 1024px) 680px, 92vw"}
                    className="block w-full h-auto"
                  />
                </div>
                <figcaption className={`land-faint text-sm mt-3 ${phone ? "text-center" : ""}`}>{caption}</figcaption>
              </figure>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
