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
  type SplitTopProps,
  type StagePage,
  type StageProps,
} from './Stage.tsx';
export { GoalPill, OverlapPill, RowPill, TaskCard, type CardStatus, type TaskCardProps } from './Card.tsx';
export { KeysHint, Launcher, NextList, SplitHome, Tips, type LauncherChip, type LauncherProps, type LauncherTool, type NextRow, type PlainTip, type SetupTip, type SplitHomeProps } from './Home.tsx';
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
export { HomePanes, PaneOff, PaneRow, PaneRows, PaneView, type HomePanesProps, type PaneRowProps, type PaneViewProps } from './Panes.tsx';
export { ChangesList, firstLine, hunkKey, hunkRuns, rowKey, type ChangeFile, type ChangeRow, type ChangesLabels, type ChangesListProps, type StageState } from './Changes.tsx';
export { PaletteSheet, paletteRowId, type PaletteRow, type PaletteSheetProps } from './Palette.tsx';
export { StuffFrame, type StuffFrameProps } from './StuffFrame.tsx';
export { RunPreview, type RunPreviewLabels, type RunPreviewProps } from './RunPreview.tsx';
export { CommentCard, CommentTray, type CommentCardProps, type CommentTrayProps } from './Comments.tsx';
export { SpareCards, type SpareCard, type SpareCardsProps } from './Spare.tsx';
