import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getObservationsCountFromEventsTable: vi.fn(),
  getObservationsWithModelDataFromEventsTable: vi.fn(),
  getCategoricalScoresGroupedByName: vi.fn(),
  getEventsGroupedByModel: vi.fn(),
  getEventsGroupedByModelId: vi.fn(),
  getEventsGroupedByName: vi.fn(),
  getEventsGroupedByTraceName: vi.fn(),
  getEventsGroupedByTraceTags: vi.fn(),
  getEventsGroupedByPromptName: vi.fn(),
  getEventsGroupedByType: vi.fn(),
  getEventsGroupedByUserId: vi.fn(),
  getEventsGroupedByVersion: vi.fn(),
  getEventsNumericStatsByFilterColumn: vi.fn(),
  getEventsGroupedBySessionId: vi.fn(),
  getEventsGroupedByLevel: vi.fn(),
  getEventsGroupedByEnvironment: vi.fn(),
  getEventsGroupedByExperimentDatasetId: vi.fn(),
  getEventsGroupedByExperimentId: vi.fn(),
  getEventsGroupedByExperimentName: vi.fn(),
  getEventsGroupedByHasParentObservation: vi.fn(),
  getEventsGroupedByIsRootObservation: vi.fn(),
  getEventsGroupedByToolName: vi.fn(),
  getEventsGroupedByCalledToolName: vi.fn(),
  getNumericScoresGroupedByName: vi.fn(),
  getScoresGroupedByNameSourceType: vi.fn(),
  getObservationsBatchIOFromEventsTable: vi.fn(),
  getScoresForObservations: vi.fn(),
  getScoresForTraces: vi.fn(),
  loggerWarn: vi.fn(),
  traceException: vi.fn(),
}));

vi.mock("@langfuse/shared/src/server", () => ({
  getObservationsCountFromEventsTable:
    mocks.getObservationsCountFromEventsTable,
  getObservationsWithModelDataFromEventsTable:
    mocks.getObservationsWithModelDataFromEventsTable,
  getCategoricalScoresGroupedByName: mocks.getCategoricalScoresGroupedByName,
  getEventsGroupedByModel: mocks.getEventsGroupedByModel,
  getEventsGroupedByModelId: mocks.getEventsGroupedByModelId,
  getEventsGroupedByName: mocks.getEventsGroupedByName,
  getEventsGroupedByTraceName: mocks.getEventsGroupedByTraceName,
  getEventsGroupedByTraceTags: mocks.getEventsGroupedByTraceTags,
  getEventsGroupedByPromptName: mocks.getEventsGroupedByPromptName,
  getEventsGroupedByType: mocks.getEventsGroupedByType,
  getEventsGroupedByUserId: mocks.getEventsGroupedByUserId,
  getEventsGroupedByVersion: mocks.getEventsGroupedByVersion,
  getEventsNumericStatsByFilterColumn:
    mocks.getEventsNumericStatsByFilterColumn,
  getEventsGroupedBySessionId: mocks.getEventsGroupedBySessionId,
  getEventsGroupedByLevel: mocks.getEventsGroupedByLevel,
  getEventsGroupedByEnvironment: mocks.getEventsGroupedByEnvironment,
  getEventsGroupedByExperimentDatasetId:
    mocks.getEventsGroupedByExperimentDatasetId,
  getEventsGroupedByExperimentId: mocks.getEventsGroupedByExperimentId,
  getEventsGroupedByExperimentName: mocks.getEventsGroupedByExperimentName,
  getEventsGroupedByHasParentObservation:
    mocks.getEventsGroupedByHasParentObservation,
  getEventsGroupedByIsRootObservation:
    mocks.getEventsGroupedByIsRootObservation,
  getEventsGroupedByToolName: mocks.getEventsGroupedByToolName,
  getEventsGroupedByCalledToolName: mocks.getEventsGroupedByCalledToolName,
  getNumericScoresGroupedByName: mocks.getNumericScoresGroupedByName,
  getScoresGroupedByNameSourceType: mocks.getScoresGroupedByNameSourceType,
  getObservationsBatchIOFromEventsTable:
    mocks.getObservationsBatchIOFromEventsTable,
  getScoresForObservations: mocks.getScoresForObservations,
  getScoresForTraces: mocks.getScoresForTraces,
  logger: { warn: mocks.loggerWarn },
  traceException: mocks.traceException,
}));

import { getEventFilterOptions } from "@/src/features/events/server/eventsService";

describe("getEventFilterOptions", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-06-22T12:00:00.000Z") });
    vi.clearAllMocks();

    for (const mock of Object.values(mocks)) {
      mock.mockResolvedValue?.([]);
    }
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("applies a default 30 day startTime filter and logs when none is provided", async () => {
    await getEventFilterOptions({ projectId: "project-1" });

    const defaultFrom = new Date("2026-05-23T12:00:00.000Z");

    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      "events.filterOptions called without startTimeFilter; applying default lookback",
      {
        projectId: "project-1",
        defaultLookbackDays: 30,
      },
    );
    expect(mocks.getEventsGroupedByLevel).toHaveBeenCalledWith(
      "project-1",
      expect.arrayContaining([
        {
          column: "startTime",
          type: "datetime",
          operator: ">=",
          value: defaultFrom,
        },
      ]),
    );
    expect(mocks.getNumericScoresGroupedByName).toHaveBeenCalledWith(
      "project-1",
      [
        {
          column: "Timestamp",
          type: "datetime",
          operator: ">=",
          value: defaultFrom,
        },
      ],
    );
    expect(mocks.getScoresGroupedByNameSourceType).toHaveBeenCalledWith({
      projectId: "project-1",
      filter: expect.arrayContaining([
        {
          column: "timestamp",
          type: "datetime",
          operator: ">=",
          value: defaultFrom,
        },
      ]),
    });
  });

  it("preserves explicit startTime filters without logging", async () => {
    const explicitFrom = new Date("2026-06-01T00:00:00.000Z");

    await getEventFilterOptions({
      projectId: "project-1",
      startTimeFilter: [
        {
          column: "startTime",
          type: "datetime",
          operator: ">=",
          value: explicitFrom,
        },
      ],
    });

    expect(mocks.loggerWarn).not.toHaveBeenCalled();
    expect(mocks.getEventsGroupedByLevel).toHaveBeenCalledWith("project-1", [
      {
        column: "startTime",
        type: "datetime",
        operator: ">=",
        value: explicitFrom,
      },
    ]);
  });
});
