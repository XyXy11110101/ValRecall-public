const GENERAL_FAILURE = '这次没有捕获成功。请刷新视频页，等画面出现后再试一次。';

const TEXT_BY_CODE: Readonly<Record<string, string>> = {
  // YouTube accepts only /watch and Bilibili only /video and Watch Later, so both exclusions hold.
  UNSUPPORTED_PAGE:
    '这个页面不能捕获。请打开 B 站、YouTube 或抖音的视频播放页，再试一次。YouTube Shorts 和 B 站番剧暂不支持。',
  VIDEO_NOT_FOUND:
    '没有找到可以捕获的视频。请等画面出现、视频开始播放后，再试一次。如果页面上有多个视频，先点开你想记的那个。',
  // The screenshot needs a key press on that tab, so the retry button alone can fall short here.
  SCREENSHOT_FAILED:
    '没能截到视频画面。请切回视频页，让画面显示出来，再试一次。重试不行时，请在视频页按捕获快捷键。如果画面总是黑的，可能是视频不允许截图。可以换个视频，或在 Edge 设置里关闭“图形加速”，再重启浏览器。',
  CAPTURE_FAILED: GENERAL_FAILURE,
};

/** Page and browser errors arrive in mixed English, so the code alone picks what the user reads. */
export function captureErrorText(code: string): string {
  return Object.hasOwn(TEXT_BY_CODE, code) ? TEXT_BY_CODE[code]! : GENERAL_FAILURE;
}
