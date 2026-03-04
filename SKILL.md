---
name: generate-image
description: Generate an image with gemini-test and return the image URL, exact prompt used, and one-click upscale link.
---

# Generate Image Skill

Use this skill when the user asks to generate an image through the gemini-test API.

## Input
- User prompt (required)
- Optional aspect ratio (`1:1`, `16:9`, `9:16`, `4:3`, `3:4`)

## API Call
`POST /api/generate` with multipart form fields:
- `prompt`
- `aspectRatio` (optional)

## Required Output Format
Always return:
1. **Image URL** (full URL)
2. **Prompt used** (exact prompt sent)
3. **Upscale Image link** (full one-click link)

Example:
- Image: `https://gemini-test.etdofresh.com/images/<file>.png`
- Prompt used: `...`
- Upscale Image: `https://gemini-test.etdofresh.com/api/upscale-link/<id>`

## Behavior Rules
- If image generation succeeds, include all 3 outputs above.
- If API returns text fallback (`textContent` with no images), show that text clearly to the user.
- If auth fails, instruct user to login from the web UI and retry.
- Prefer concise, user-friendly responses.

## Notes
- Upscale links are cached for up to 24 hours.
- If an upscale link is expired, the API may return an expiration/error response.
