"use client";

// The member door: a club code box that takes a member straight to their
// gym's own sign-in page (/login?club=<code>, the same door a club's short
// link opens). Without JavaScript the form still submits to /login with the
// code as typed.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { clubCodeInputFilter, normaliseClubCode } from "@/lib/club-code";

export function MemberDoor() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [error, setError] = useState("");

  function onChange(value: string) {
    // A pasted link or club address is reduced to its code, as on the login page.
    setCode(/[/?]/.test(value) ? normaliseClubCode(value).toUpperCase() : clubCodeInputFilter(value));
    setError("");
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const club = normaliseClubCode(code);
    if (!club) {
      setError("Enter your club code.");
      return;
    }
    router.push(`/login?club=${encodeURIComponent(club)}`);
  }

  return (
    <section id="find-my-gym" aria-labelledby="find-my-gym-title" className="land-card p-6 sm:p-8">
      <h2 id="find-my-gym-title" className="land-display text-3xl sm:text-4xl mb-2">
        Train here?
      </h2>
      <p className="land-muted text-base mb-6">Enter your club code to go to your gym.</p>

      <form action="/login" method="get" onSubmit={onSubmit} noValidate className="flex flex-col gap-3">
        <label htmlFor="club-code" className="text-sm font-semibold">
          Club code
        </label>
        <input
          id="club-code"
          name="club"
          value={code}
          onChange={(e) => onChange(e.target.value)}
          autoCapitalize="characters"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "club-code-error" : "club-code-help"}
          className="land-input w-full px-4 min-h-12 rounded-xl text-base tracking-wide"
        />
        {error && (
          <p id="club-code-error" role="alert" className="text-sm font-medium">
            {error}
          </p>
        )}
        <button
          type="submit"
          className="land-btn-primary inline-flex items-center justify-center px-6 min-h-12 rounded-xl text-base font-semibold"
        >
          Go to my gym
        </button>
      </form>

      <p id="club-code-help" className="land-faint text-sm mt-5">
        Ask your coach if you do not have your club code.
      </p>
    </section>
  );
}
