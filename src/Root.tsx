import { CalculateMetadataFunction, Composition, staticFile } from "remotion";
import { timingOf } from "./schedule";
import { Timelapse, TimelapseProps, timelapseSchema } from "./Timelapse";

const FPS = 30;

// The timeline JSON is read here, once: the component receives it as data, and the duration is the
// sum of the scene lengths the timeline asks for.
const calculateMetadata: CalculateMetadataFunction<TimelapseProps> = async ({ props, abortSignal }) => {
  const res = await fetch(staticFile(props.timeline), { signal: abortSignal });
  const data = await res.json();
  const t = timingOf(data);
  return {
    durationInFrames: Math.round(
      (t.openingSeconds + t.growthSeconds + t.pullbackSeconds + t.holdSeconds) * FPS,
    ),
    props: { ...props, data },
    defaultOutName: `${data.name}-timelapse`,
  };
};

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="WikiTimelapse"
      component={Timelapse}
      schema={timelapseSchema}
      calculateMetadata={calculateMetadata}
      durationInFrames={2250}
      fps={FPS}
      width={1920}
      height={1080}
      defaultProps={{
        timeline: "timelines/research-atlas.json",
        legend: "created or written",
        timeZone: "Europe/Amsterdam",
        columns: 2,
        palette: {
          background: "#0b0f17",
          surface: "#131a26",
          ink: "#e6edf7",
          muted: "#9aa6b8",
          written: "#ff8a3d",
          tile: "#3a475a",
        },
      }}
    />
  );
};
