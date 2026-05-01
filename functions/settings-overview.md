# Settings - Overview Tab

> **Status:** ✅ Working · read-only summary of tenant metrics and quick action cards.

## Purpose

Display a high-level dashboard of gym operations: tenant name, plan tier, member/staff/class counts, member status breakdown, and quick-access action buttons to major settings tabs.

---

## User-facing surfaces

| Element | Type | Source |
|---|---|---|
| Tenant name + plan tier | Info chip | `settings.name`, `settings.subscriptionTier` |
| Members / Staff / Classes | 3-column stat grid | `tenant._count.members`, `.users`, `.classes` |
| Member Status breakdown | Card with color-coded rows | `prisma.member.groupBy({by: ["status"]})` |
| Gym Info details | KV pairs (name, code, plan, since) | `settings.*` + creation date |
| Quick action cards | 2x2 grid (Branding, Revenue, Store, Staff) | Navigation buttons to other tabs |

---

## Data flow

### Server-side (app/dashboard/settings/page.tsx)

```typescript
const [tenant, staff, memberStats, currentUser] = await Promise.all([
  prisma.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    include: {
      _count: {
        select: {
          members: true,
          users: true,
          classes: { where: { isActive: true } },
        },
      },
    },
  }),
  // ... staff and currentUser
]);

const statusCounts: Record<string, number> = {};
for (const s of memberStats) statusCounts[s.status] = s._count.status;
```

Transforms to `TenantSettings` type with:
- `memberCount`, `staffCount`, `classCount`
- `id`, `name`, `slug`, `subscriptionTier`, `subscriptionStatus`, `createdAt`

### Client-side (components/dashboard/SettingsPage.tsx)

```typescript
{tab === "overview" && (
  <div className="space-y-4">
    {/* 3-col stat grid */}
    <div className="grid grid-cols-3 gap-3">
      {[
        { label: "Members", value: totalMembers || settings?.memberCount || 0 },
        { label: "Staff",   value: settings?.staffCount ?? staff.length },
        { label: "Classes", value: settings?.classCount ?? 0 },
      ].map(({ label, value }) => (...))}
    </div>

    {/* Member Status breakdown */}
    <div className="rounded-2xl border p-5">
      {[
        { key: "active",    label: "Active",    color: "#10b981" },
        { key: "taster",    label: "Tasters",   color: "#3b82f6" },
        { key: "paused",    label: "Paused",    color: "#f59e0b" },
        { key: "inactive",  label: "Inactive",  color: "#6b7280" },
        { key: "cancelled", label: "Cancelled", color: "#ef4444" },
      ].map(({ key, label, color }) => {
        const count = statusCounts[key] ?? 0;
        if (count === 0) return null;
        return (
          <div key={key} className="flex items-center justify-between py-2">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full" style={{ background: color }} />
              <span>{label}</span>
            </div>
            <span>{count}</span>
          </div>
        );
      })}
    </div>

    {/* Quick actions */}
    <div className="grid grid-cols-2 gap-3">
      {[
        { label: "Branding",     action: () => setTab("branding") },
        { label: "Revenue",      action: () => setTab("revenue") },
        { label: "Club Store",   action: () => setTab("store") },
        { label: "Manage Staff", action: () => setTab("staff") },
      ].map(({ label, action }) => (...))}
    </div>
  </div>
)}
```

---

## Status badge logic

- **No custom branding**: shows plan tier
- **No members**: displays "No members yet" placeholder
- **Always read-only**: owner cannot edit from this tab

---

## Related docs

- [settings-branding.md](settings-branding.md) — Branding quick link
- [settings-revenue.md](settings-revenue.md) — Revenue quick link
- [settings-store.md](settings-store.md) — Store quick link
- [settings-staff.md](settings-staff.md) — Staff quick link
