import { createFileRoute } from "@tanstack/react-router";
import { BoatCloudSettings } from "../components/settings/BoatCloudSettings";
import { SettingsPageContainer } from "../components/settings/settingsLayout";

function SettingsBoatRoute() {
  return (
    <SettingsPageContainer>
      <BoatCloudSettings />
    </SettingsPageContainer>
  );
}

export const Route = createFileRoute("/_chat/settings/boat")({
  component: SettingsBoatRoute,
});
