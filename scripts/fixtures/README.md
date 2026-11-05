# Feed layout video fixtures

These small, silent VP8 WebM clips replace live canvas recording only in
`feed-cards-fit.mjs`. The preview otherwise keeps its drawn animated clips.
They retain the actual portrait (540×720) and landscape (1920×1080) dimensions,
so the browser still decodes video and applies the resulting aspect ratios.
The existing readiness and overflow assertions are unchanged.

A busy runner can delay canvas frames beyond the recorder's two-second stop
timer. Caching a nonempty recording does not prove it is decodable. Prerecorded
fixtures remove that timing dependency from a layout test.

Created from plain solid colours with FFmpeg; no third-party media. Recreate:

```sh
ffmpeg -f lavfi -i color=c=steelblue:s=540x720:r=2 -t 1 -c:v libvpx -b:v 40k -an feed-portrait.webm
ffmpeg -f lavfi -i color=c=teal:s=1920x1080:r=2 -t 1 -c:v libvpx -b:v 40k -an feed-landscape.webm
```
