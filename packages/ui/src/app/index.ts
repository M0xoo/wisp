// The app's frame and its pieces as v1 draws them (design/foundation.md): the stage, the crew rail,
// the sidebar's head, New task, the list's sections and rows, Home and the open task.
export {
  CrewRail,
  Feed,
  FeedItem,
  FeedSection,
  SidebarHead,
  SplitTop,
  Stage,
  type CrewRailProps,
  type FeedSectionProps,
  type ProjectChip,
  type RailMember,
  type SidebarHeadProps,
  type MeFace,
  type SplitTopProps,
  type StagePage,
  type StageProps,
} from './Stage.tsx';
export { GoalPill, OverlapPill, RowPill, TaskCard, type CardStatus, type TaskCardProps } from './Card.tsx';
export {
  KeysHint,
  FeedbackLine,
  Launcher,
  NextList,
  SplitHome,
  Tips,
  type LauncherChip,
  type LauncherCompare,
  type LauncherProps,
  type LauncherRecipe,
  type LauncherTool,
  type NextRow,
  type PlainTip,
  type SetupTip,
  type SplitHomeProps,
} from './Home.tsx';
export { LauncherSetup, type LauncherSetupProps } from './LauncherSetup.tsx';
export {
  OverlapNote,
  ReplyBox,
  TaskBody,
  TaskDetails,
  TaskHead,
  TurnView,
  type OverlapNoteProps,
  type ReplyBoxProps,
  type TaskAction,
  type TaskDetailsProps,
  type TaskHeadProps,
  type TrailItem,
  type TurnViewProps,
} from './Task.tsx';
export { WithAct, ActIcon, type Act } from './act.tsx';
export { HomePanes, PaneCard, PaneOff, PaneRow, PaneRows, PaneView, type HomePanesProps, type PaneCardProps, type PaneRowProps, type PaneSeg, type PaneViewProps } from './Panes.tsx';
export { ChangesList, firstLine, hunkKey, hunkRuns, rowKey, type ChangeFile, type ChangeRow, type ChangesLabels, type ChangesListProps, type StageState } from './Changes.tsx';
export { PickStrip, type PickStripChip, type PickStripProps } from './PickStrip.tsx';
export { PaletteSheet, paletteRowId, type PaletteRow, type PaletteSheetProps } from './Palette.tsx';
export { StuffFrame, type StuffFrameProps } from './StuffFrame.tsx';
export { RunPreview, type RunPreviewLabels, type RunPreviewProps } from './RunPreview.tsx';
export { CommentCard, CommentTray, type CommentCardProps, type CommentTrayProps } from './Comments.tsx';
export { SpareCards, type SpareCard, type SpareCardsProps } from './Spare.tsx';
export { HomeUsage, type HomeUsageGroup, type HomeUsageProps, type HomeUsageWindow } from './HomeUsage.tsx';
export { RailCardBody, headingForCard, stepRow, type RailCardBodyProps, type RailCardRow } from './RailCard.tsx';
export { AutoPop, type AutoPopProps, type AutoPopRow } from './AutoPop.tsx';
export { ProjectsSheet, type ProjectsSheetProps, type ProjectsRow, type ProjectsPlace } from './ProjectsSheet.tsx';
export { BtwList, type BtwItem } from './Btw.tsx';
export { RateButtons, WhyForm, type Rating, type RateProps, type WhyFormProps } from './Rate.tsx';
export { CompareRuns, type CompareRunsProps, type CompareRowView, type CompareRunView, type CompareCellView } from './Compare.tsx';
export { AutomationsBody, AutoRunner, AutoList, TriggerKinds, AutoRow, AutoPresets, AutoNote, AutoFoot, type AutomationsTab, type AutoItem, type TriggerKind, type Rich } from './Automations.tsx';
export { TaskUsage, type TaskUsageProps, type TaskUsageRow, type TaskUsageSection } from './TaskUsage.tsx';
