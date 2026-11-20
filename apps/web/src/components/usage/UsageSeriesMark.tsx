import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { BoatIcon } from "../Icons";
import { COMPUTE_SERIES, PROVIDER_PRESENTATION, type UsageSeriesKind } from "./usageProviders";

export function UsageSeriesMark({
  series,
  className,
}: {
  readonly series: UsageSeriesKind;
  readonly className: string;
}) {
  if (series === COMPUTE_SERIES) return <BoatIcon aria-hidden className={className} />;
  const presentation = PROVIDER_PRESENTATION[series];
  return (
    <ProviderInstanceIcon
      driverKind={presentation.driverKind}
      displayName={presentation.label}
      iconClassName={className}
    />
  );
}
