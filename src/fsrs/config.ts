import { FSRSVersion, generatorParameters, type FSRSParameters } from 'ts-fsrs';

export const SHORT_TERM_REVIEW_MODES = ['off', 'light', 'standard'] as const;
export type ShortTermReviewMode = (typeof SHORT_TERM_REVIEW_MODES)[number];

export const DEFAULT_SHORT_TERM_REVIEW_MODE: ShortTermReviewMode = 'standard';

const standardParameters = generatorParameters();

const learningStepsByMode: Record<ShortTermReviewMode, FSRSParameters['learning_steps']> = {
  off: [],
  // ts-fsrs treats a one-entry list as the Again/Hard step and graduates Good
  // immediately. Equal 10-minute entries provide one distinct short-term return
  // for Good while removing Standard's one-minute micro-step.
  light: ['10m', '10m'],
  standard: ['1m', '10m'],
};

export interface FsrsSchedulerConfiguration {
  packageVersion: string;
  algorithmVersion: string;
  shortTermReviewMode: ShortTermReviewMode;
  parameters: FSRSParameters;
}

export function isShortTermReviewMode(value: unknown): value is ShortTermReviewMode {
  return (
    typeof value === 'string' && SHORT_TERM_REVIEW_MODES.includes(value as ShortTermReviewMode)
  );
}

export function parametersForShortTermMode(mode: ShortTermReviewMode): FSRSParameters {
  return {
    ...standardParameters,
    w: [...standardParameters.w],
    enable_short_term: true,
    learning_steps: [...learningStepsByMode[mode]],
    // Forgotten Review cards retain the verified ten-minute relearning policy in
    // every mode. Changing the New-card preference must not erase that safeguard.
    relearning_steps: [...standardParameters.relearning_steps],
  };
}

export function schedulerConfiguration(
  mode: ShortTermReviewMode,
  parameters: FSRSParameters = parametersForShortTermMode(mode),
): FsrsSchedulerConfiguration {
  const [packageVersion = FSRSVersion, algorithmVersion = FSRSVersion] =
    FSRSVersion.split(' using ');
  return {
    packageVersion,
    algorithmVersion,
    shortTermReviewMode: mode,
    parameters: {
      ...parameters,
      w: [...parameters.w],
      learning_steps: [...parameters.learning_steps],
      relearning_steps: [...parameters.relearning_steps],
    },
  };
}
