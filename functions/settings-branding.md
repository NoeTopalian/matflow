# Settings - Branding Tab

> **Status:** ✅ Working · logo upload to Vercel Blob (LB-002 commit 18f4061) · 12 dark + 4 light theme presets · fine-tune colours · font picker · real-time phone preview · persists via PATCH /api/settings and localStorage.

## Purpose

Customize gym branding: gym name, logo upload, colour scheme (primary/secondary/text/background), font family, and logo sizing. All changes propagate to member app within 5 minutes via JWT brand-refresh token (LB-004 / lib/brand-refresh.ts).

---

## User-facing surfaces

| Element | Type | Action |
|---|---|---|
| Gym Name | Text input | Saved to `Tenant.name` |
| Club Logo | File upload (PNG) | POSTs to `/api/upload` → Vercel Blob, stored as `logoUrl` |
| Logo Size | 3-button grid (sm/md/lg) | Saved as `logoSize` field |
| Theme Presets | 12 dark + 4 light cards | Apply preset colours + font (no DB save until Save Branding) |
| Fine-tune Colours | 4 inputs (primary/secondary/text/bg) | Allows override after preset |
| Club Font | 6 font options | Picker with sample text, Google Fonts loaded on tab open |
| Logo Background Fill | none / black / white | For logos with transparency |
| Phone Preview | Right-side sticky frame | Live updates as settings change |
| Save Branding button | CTA | PATCH `/api/settings` |

---

## Data flow

### Server init (app/dashboard/settings/page.tsx)

```typescript
const settings = {
  name: tenant.name,
  logoUrl: tenant.logoUrl,
  logoSize: tenant.logoSize,  // "sm" | "md" | "lg"
  primaryColor: tenant.primaryColor,
  secondaryColor: tenant.secondaryColor,
  textColor: tenant.textColor,
  // ... other fields
};
```

### Client state (components/dashboard/SettingsPage.tsx)

```typescript
const [gymName, setGymName]           = useState(settings?.name ?? "");
const [primaryCol, setPrimaryCol]     = useState(settings?.primaryColor   ?? primaryColor);
const [secondaryCol, setSecondaryCol] = useState(settings?.secondaryColor ?? "#2563eb");
const [textCol, setTextCol]           = useState(settings?.textColor      ?? "#ffffff");
const [bgCol, setBgCol]               = useState("#111111");  // member app BG
const [fontFamily, setFontFamily]     = useState("Inter, sans-serif");
const [logoPreview, setLogoPreview]   = useState<string | null>(settings?.logoUrl ?? null);
const [logoFile, setLogoFile]         = useState<File | null>(null);
const [logoBg, setLogoBg]             = useState<"none" | "black" | "white">("none");
const [logoSize, setLogoSize]         = useState<"sm" | "md" | "lg">(settings?.logoSize ?? "md");
const [activePreset, setActivePreset] = useState<string | null>(null);
const [saving, setSaving]             = useState(false);
```

### Theme presets (THEME_PRESETS const)

```typescript
const THEME_PRESETS: ThemePreset[] = [
  // Dark (8 presets)
  { name: "Classic BJJ",    style: "Dark · Pro",       primary: "#3b82f6", ... mode: "dark" },
  { name: "Dojo Black",     style: "Dark · Prestige",  primary: "#d97706", ... mode: "dark" },
  { name: "Fight Night",    style: "Dark · Energy",    primary: "#ef4444", ... mode: "dark" },
  // ... 5 more dark presets
  // Light (4 presets)
  { name: "Clean White",    style: "Light · Modern",   primary: "#1d4ed8", ... mode: "light" },
  // ... 3 more light presets
];
```

### Save flow (saveBranding)

1. **Logo upload** (if file selected):
   - POST to `/api/upload` with FormData
   - Returns `{ url }` (Vercel Blob public URL)
   - On failure, surfaces error but doesn't abort

2. **localStorage sync** (always):
   - Saves preview state to `gym-settings` for demo mode
   - Applied immediately via CSS custom properties

3. **DB persist** (PATCH /api/settings):
   ```typescript
   {
     name: gymName,
     primaryColor: primaryCol,
     secondaryColor: secondaryCol,
     textColor: textCol,
     bgColor: bgCol,
     fontFamily,
     logoUrl: persistedLogoUrl,  // null if data:// URL
     logoSize,
   }
   ```

4. **Toast feedback**:
   - Success: "Branding saved — member app updated"
   - Upload error: "Branding saved, but {error}"

---

## Key features

### Logo upload (LB-002)

- Accepts: `.jpg`, `.png`, `.gif`, `.webp`, etc.
- Max 2MB recommended (enforced client-side, server may reject)
- Uploads to Vercel Blob with tenant scoping
- Preview updates immediately via FileReader dataURL
- Replace/Remove buttons for uploaded logos

### Theme presets

- **Dark** (8): Classic BJJ, Dojo Black, Fight Night, Purple Reign, Forest Warrior, Cyber, Midnight, Crimson Gi
- **Light** (4): Clean White, Fresh Green, Warm Sand, Ocean Breeze
- Each has: `primary`, `secondary`, `text`, `bg`, `font`, `fontLabel`, `mode`
- Clicking a preset updates all 4 colour fields + font family
- Active preset shows highlighted border + glow

### Font picker

- 6 fonts + fallback family: Inter, Oswald, Montserrat, Space Grotesk, Rajdhani, Playfair Display
- Google Fonts loaded on tab open via FONT_IMPORTS_MAP
- Each shows: codename, real name, sample text, vibe descriptor
- Active font shows highlighted border

### Phone preview (right pane, XL screens only)

- Fixed position, sticky top
- 280px wide iPhone frame with notch
- Renders PhonePreview component with live colours/font/logo
- Updates as user adjusts settings (no debounce)

---

## Permission model

- **Owner**: can edit all fields, upload logo, select presets, fine-tune colours
- **Non-owner**: read-only warning banner, inputs disabled

---

## API integrations

| Endpoint | Method | Auth | Purpose |
|---|---|---|---|
| `/api/upload` | POST | Owner | Upload logo file to Vercel Blob |
| `/api/settings` | PATCH | Owner | Persist name, colours, font, logo to Tenant |

---

## Propagation (LB-004)

Changes to `Tenant.primaryColor`, `.secondaryColor`, `.textColor`, `.logoUrl` trigger a brand-refresh within ~5 minutes via JWT re-issue. Members' JWT contains cached values; next login or refresh picks up new values.

---

## Related docs

- [lib/brand-refresh.ts](../lib/brand-refresh.ts) — JWT brand-refresh token logic
- [components/ui/PhonePreview.tsx](../components/dashboard/SettingsPage.tsx#L145) — Phone frame component
- [THEME_PRESETS](../components/dashboard/SettingsPage.tsx#L59) — All preset definitions
