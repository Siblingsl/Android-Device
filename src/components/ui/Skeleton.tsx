interface Props {
  width?: string | number;
  height?: string | number;
  radius?: number;
  count?: number;
}

export function Skeleton({ width = "100%", height = 16, radius = 8, count = 1 }: Props) {
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="sk"
          style={{
            width,
            height,
            borderRadius: radius,
            marginBottom: count > 1 ? 10 : 0,
          }}
        />
      ))}
    </>
  );
}
