---
name: post-video-social
description: Post a finished vertical clip to TikTok and YouTube Shorts by driving Sean's Chrome. Use whenever a video is ready and the ask is to post, publish, upload, share, or put it on TikTok / TT / YouTube / YT / Shorts / socials, and when a caption, title, description, hashtags or visibility need setting on a post. Covers the hidden file-input trick both sites need, the 10 MB upload cap and how to make a copy that fits, the hashtag autocomplete trap, TikTok's content review, and which channel the uploads actually land on. For MAKING the video, use record-video-export.
---

# Post a Clip to TikTok and YouTube

Both flows are driven with the `claude-in-chrome` tools. Chrome is already
signed in to both; no credentials are needed. Load the tools in ONE ToolSearch
call:

```
select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__computer,mcp__claude-in-chrome__find,mcp__claude-in-chrome__file_upload,mcp__claude-in-chrome__javascript_tool,mcp__claude-in-chrome__read_console_messages,mcp__claude-in-chrome__browser_batch
```

The live game is **https://itscampingseason.com/**. Every description and
caption links it, with a per-clip UTM so the two platforms can be told apart:

```
https://itscampingseason.com/?utm_source=youtube&utm_medium=social&utm_campaign=shorts&utm_content=<slug>
```

Each clip in `marketing/queue/<slug>/` carries a `post.md` with the caption,
title and description already written for it. Use those rather than inventing
new ones — they were reviewed alongside the cut.

## Make an upload copy first

`file_upload` caps at **10 MB combined** and only reads session-readable paths,
so copy into the scratchpad. `trailer_post.mjs --max-mb` budgets the VIDEO
stream and ~190 kbit/s of AAC lands on top, so 9.5 came out at 9.55 MB.

Both platforms re-encode anyway, but H.264 is what has worked every time, so
render the master uncapped and transcode down rather than shipping the tool's
HEVC path:

```bash
node tools/trailer_post.mjs --cut shots/trailer/<cut>.mp4 \
  --cards marketing/queue/<slug>/cards.json --max-mb 0 --out "$U/master.mp4"
ffmpeg -y -i "$U/master.mp4" -c:v libx264 -preset slow \
  -b:v 3900k -maxrate 4700k -bufsize 7800k -pix_fmt yuv420p \
  -c:a aac -b:a 192k -movflags +faststart "$U/<slug>.mp4"
```

That lands around 6-7 MB for 15-20 s. Delete the master afterwards.

## The file input is hidden on BOTH sites

Each renders a styled "Select files" button and keeps the real
`<input type=file>` off the accessibility tree, so `read_page` and `find` never
return it and `file_upload` refuses the button with "Element is not a file
input". Unhide it, label it, upload by ref:

```js
const l = document.querySelectorAll('input[type=file]');
[...l].forEach((i, n) => {
  i.removeAttribute('hidden');
  i.style.cssText = 'position:fixed;top:' + (100 + n * 50) + 'px;left:100px;' +
                    'width:250px;height:40px;opacity:1;z-index:99999;display:block';
  i.setAttribute('aria-label', 'pickfile' + n);
});
l.length
```

Then `find` for `pickfile0` and hand that ref to `file_upload`. Two notes:

- `javascript_tool` may return `[BLOCKED: Cookie/query string data]` instead of
  a value. The mutation still happened — just `find` for the label.
- On YouTube the input only exists **once the upload dialog is open**, and it is
  not in a shadow root. Open the dialog first (the upload arrow in the header,
  or the "Upload videos" button), then run the snippet.

## TikTok

1. Navigate to `https://www.tiktok.com/tiktokstudio/upload?from=webapp&tab=video`.
2. Unhide the input, `file_upload`, then **wait ~18 s** and screenshot. Success
   looks like `<name>.mp4  Uploaded (N MB)` with a green tick and a cover
   thumbnail. A spinner still sitting on "Select video to upload" is a failure.
3. Caption: click the Description box, `cmd+a`, Delete, type the caption text,
   then the hashtags **one at a time** (see the autocomplete trap).
4. Scroll down. Confirm *Now*, *Everyone*, HD on. The music copyright check
   finishes in under a minute; **Content check lite takes ~10 minutes**.
5. Post. If the check is still running a "Continue to post?" dialog appears —
   "Post now" is fine. The post lands as **Content under review / Only me** and
   flips to Everyone within a few minutes. That is normal, not a failure.

**TikTok captions do not render clickable links.** The URL goes in as plain text
and the real link belongs in the profile bio.

### `Network request failed, status: 0` is intermittent — and I have now been
### wrong about it twice

- 2026-09-04, two failures with a `[IMPORTANT NOTICE] There are more than 2
  WEBMSSDKs integrated in this page` console line. I concluded TikTok detects
  injected files and told Sean it was blocked. **Wrong** — that WEBMSSDK line
  appears on successful uploads too, and the same injection worked later.
- 2026-09-05, three failures in a row on tabs this session created, then a
  success on a tab Sean opened. I concluded it needed a user-opened tab.
  **Also wrong** — the very next upload succeeded on a session-created tab.

It is simply flaky, and nothing observable predicts it. Retry two or three
times, reloading the tab between attempts. If it still will not take, ask Sean
to open the upload page and drop the file in himself, then drive the caption and
Post from his tab — that costs him ten seconds and always works. Do not spend
more than a few turns on it, and do not narrate a new theory about why.

## YouTube

1. Go to `https://studio.youtube.com/`, open the upload dialog, unhide the
   input, `file_upload`.
2. Title, then description. **Type the description including its hashtags in one
   go**, then click a neutral part of the dialog to dismiss the suggestion
   dropdown.
3. Scroll to Audience and answer **"No, it's not made for kids"** — required
   before the wizard will let you publish.
4. `Next` three times (Details, Video elements, Checks) to reach Visibility.
   A "Help us improve YouTube" popup can sit on top of the Next button; dismiss
   it. Prefer `find` for the button and click by ref — the dialog's size and
   position change between sessions.
5. Choose **Public** — the default is Private — and Publish.

**Never press Escape in YouTube's dialog.** It closes the ENTIRE upload modal,
not just the hashtag dropdown (TikTok's Escape only closes the dropdown).
Nothing is lost — the title and description autosave and the upload becomes a
draft — but recovery is fiddly: Content, then the **Shorts** tab (a vertical
clip is NOT under Videos, which shows "No content available"), then "Edit
draft".

**Description links are clickable — verified 2026-09-05.** The channel passed
YouTube's advanced-features verification (ID upload) and the URLs now render as
real anchors. **It applied RETROACTIVELY**: videos published days before the
verification, checked on their public watch pages, carry the link too. YouTube
renders the description at display time, so nothing needed re-editing. Confirmed
on three Shorts spanning Sep 3-5.

So every Short's UTM link now works, and YouTube-driven traffic is finally
attributable in PostHog — see [[procedural-fall-social-traffic]] for the
pre-verification baseline to compare against.

If it ever needs doing again: Studio -> any video -> Details -> the grey line
under the description -> the word **verification** -> a "Get advanced features"
dialog offering a 6-second selfie video, a photo of an ID, or waiting ~2 months
of channel history. This is NOT phone verification (youtube.com/verify) — that
was already done and is a different gate. **The selfie and ID options are
Sean's to complete, never Claude's** — open the dialog for him and stop
there.

## Which channel this actually posts to

**"Camping Season", 3-5 subscribers** — not the 11.1k developer channel. An
early recon pass read the signed-in Google account and recorded the wrong one,
and copy was drafted for a dev audience on the strength of it. Check the channel
name in the Studio sidebar before writing anything. The cozy-game framing is
right for this channel.

## After posting

Record the URL and the date in the clip's `post.md`, and flip its header from
`not posted` to `POSTED <date>` with both links. `marketing/queue/` is the only
record of what has gone out.

Early numbers to sanity-check against (2026-09-05): the Shorts sit at 600-1,100
views each with ~50% average percentage viewed; TikTok runs 90-290 per post.
