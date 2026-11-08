// The app's frame and its pieces as v1 draws them (design/foundation.md): the stage, the crew rail,
// the sidebar's head, New task, the list's sections and rows, Home and the open task.
export { CrewRail, Feed, FeedSection, SidebarHead, SplitTop, Stage, type CrewRailProps, type FeedSectionProps, type ProjectChip, type RailMember, type SidebarHeadProps, type SplitTopProps, type StagePage, type StageProps } from './Stage.tsx';
export { TaskCard, type CardStatus, type TaskCardProps } from './Card.tsx';
export { KeysHint, Launcher, NextList, SplitHome, Tips, type LauncherChip, type LauncherProps, type LauncherTool, type NextRow, type PlainTip, type SetupTip, type SplitHomeProps } from './Home.tsx';
export { OverlapNote, ReplyBox, TaskBody, TaskDetails, TaskHead, TurnView, type OverlapNoteProps, type ReplyBoxProps, type TaskAction, type TaskDetailsProps, type TaskHeadProps, type TrailItem, type TurnViewProps } from './Task.tsx';
export { WithAct, ActIcon, type Act } from './act.tsx';
