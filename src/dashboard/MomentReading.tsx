import type { LearningItem } from '../database';
import { isImageLearningItem, isVideoLearningItem, learningItemTitle } from '../database';
import { NoteContentView } from '../intake/NoteContentView';
import { ReadingSourceDetails } from '../reading/ReadingSourceDetails';
import { SourceContextDisclosure, SourceContextExcerpt } from '../shared/components';
import { ItemThumbnail } from './ItemThumbnail';
import { classifyLegacyReason } from './legacy-reason';
import { classifyLegacyReferenceAnswer } from './legacy-reference-answer';

export function MomentReading({ item }: { item: LearningItem }) {
  const video = isVideoLearningItem(item) ? item : null;
  const legacyAnswer = classifyLegacyReferenceAnswer(item);
  const legacyReason = classifyLegacyReason(item);
  const imageId = isImageLearningItem(item) ? item.imageAssetId : video?.screenshotId;
  return (
    <>
      {imageId && (
        <ItemThumbnail
          screenshotId={imageId}
          alt={learningItemTitle(item)}
          className="library-reading-image"
          hideWhenMissing
        />
      )}
      <h4>问题</h4>
      <p>{item.recallPrompt}</p>
      <h4>答案要点</h4>
      <p className="library-reading-answer">{item.coreLesson}</p>
      {item.sourceType === 'text' && item.readingSource && (
        <ReadingSourceDetails source={item.readingSource} />
      )}
      {item.sourceType === 'text' && item.noteSource && (
        <details className="reading-source-details">
          <summary>来源材料</summary>
          <NoteContentView content={item.noteSource} />
        </details>
      )}
      {(
        [
          ['情境', item.situation],
          ['避免的错误', item.mistakeToAvoid],
          ['建议行动', item.recommendedAction],
          ['个人笔记', item.personalNote],
        ] as const
      )
        .filter(([, value]) => value.trim())
        .map(([label, value]) => (
          <div key={label}>
            <h4>{label}</h4>
            <p>{value}</p>
          </div>
        ))}
      {legacyAnswer.kind === 'distinct' && (
        <details>
          <summary>旧版参考答案</summary>
          <p>{legacyAnswer.value}</p>
        </details>
      )}
      {legacyReason.kind === 'distinct' && (
        <details>
          <summary>旧版补充说明</summary>
          <p>{legacyReason.value}</p>
        </details>
      )}
      {item.tags.length > 0 && <p className="muted">标签：{item.tags.join(' · ')}</p>}
      {video && (
        <>
          <SourceContextExcerpt current={video.subtitleCurrent} />
          <SourceContextDisclosure
            before={video.subtitleBefore}
            current={video.subtitleCurrent}
            after={video.subtitleAfter}
            summary="来源详情"
          >
            <p>
              {video.videoTitle} · {video.timestampDisplay}
            </p>
            {video.uploader && <p>{video.uploader}</p>}
            {video.description && <p>{video.description}</p>}
            {video.chapterTitle && <p>{video.chapterTitle}</p>}
          </SourceContextDisclosure>
        </>
      )}
    </>
  );
}
