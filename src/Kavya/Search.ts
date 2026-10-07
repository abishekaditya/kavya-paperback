import {
	PartialSourceManga,
	RequestManager,
	SearchRequest,
	SourceStateManager
} from '@paperback/types';
import { CacheManager } from './CacheManager';
import {
	KavitaRequestInterceptor,
	getKavitaAPI,
	getOptions,
	getServerUnavailableMangaTiles,
	searchRequestToString
} from './Common';

// Kavita FilterV2 values, unchanged from Kavita 0.8.0 through 0.9.x.
// POST /Series/all (the legacy filter) was removed in Kavita 0.8.9, so every
// search goes through POST /Series/v2 instead.
const FILTER_COMPARISON_CONTAINS = 5; // any of the comma-separated ids
const FILTER_COMPARISON_MUST_CONTAIN = 6; // all of the comma-separated ids
const FILTER_COMBINATION_OR = 0;
const FILTER_COMBINATION_AND = 1;
const FILTER_FIELD: Record<string, number> = {
	tags: 6,
	genres: 18
};
// Translators, Characters, Publisher, Editor, CoverArtist, Letterer, Colorist,
// Inker, Penciller, Writers, Imprint, Team and Location. Kavita 0.8.4+ no
// longer reports a person's role, so a person is looked up under every role.
// Kavita maps the Colorist field to the Inker role, so on 0.8.4+ people
// credited only as colorist cannot be found.
const PERSON_FILTER_FIELDS = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 29, 30, 31];
const WRITERS_FILTER_FIELD = 17;

async function filterSeries(
	statements: { comparison: number, field: number, value: string }[],
	combination: number,
	requestManager: RequestManager,
	kavitaAPI: { url: string, key: string }
): Promise<any[]> {
	const request = App.createRequest({
		url: `${kavitaAPI.url}/Series/v2`,
		data: JSON.stringify({
			statements: statements,
			combination: combination,
			sortOptions: { sortField: 1, isAscending: true },
			limitTo: 0
		}),
		method: 'POST'
	});

	const response = await requestManager.schedule(request, 1);
	// Fail loudly: an empty list here is what hid the removal of /Series/all.
	if (response.status >= 400) {
		throw new Error(`Kavita returned HTTP ${response.status} for a series filter`);
	}

	const result = parseJSON(response.data, []);
	return Array.isArray(result) ? result : [];
}

function parseJSON(data: string | undefined, fallback: any): any {
	try {
		return data ? JSON.parse(data) : fallback;
	} catch {
		return fallback;
	}
}

function personStatements(people: { id: number, role?: number }[]) {
	// Before Kavita 0.8.4 a person has one id per role and every person field
	// ignores the role, so one field is enough. Kavita 0.7.x also lacks fields 29-31.
	const fields = people.some((person) => person.role !== undefined) ? [WRITERS_FILTER_FIELD] : PERSON_FILTER_FIELDS;
	const value = people.map((person) => person.id).join(',');
	return fields.map((field) => ({ comparison: FILTER_COMPARISON_CONTAINS, field: field, value: value }));
}

function seriesTile(series: any, kavitaAPI: { url: string, key: string }): PartialSourceManga {
	return App.createPartialSourceManga({
		title: series.name,
		image: `${kavitaAPI.url}/image/series-cover?seriesId=${series.id}&apiKey=${kavitaAPI.key}`,
		mangaId: `${series.id}`,
		subtitle: undefined
	});
}

export async function searchRequest(
	searchQuery: SearchRequest,
	metadata: any,
	requestManager: RequestManager,
	interceptor: KavitaRequestInterceptor,
	stateManager: SourceStateManager,
	cacheManager: CacheManager
) {
	// This function is also called when the user search in an other source. It should not throw if the server is unavailable.
	if (!(await interceptor.isServerAvailable())) {
		return App.createPagedResults({
			results: getServerUnavailableMangaTiles(),
		});
	}
	
	const kavitaAPI = await getKavitaAPI(stateManager);
	const { enableRecursiveSearch, excludeUnsupportedLibrary, pageSize } = await getOptions(stateManager);
	const page: number = metadata?.page ?? 0;

	const excludeLibraryIds: number[] = [];

	if (excludeUnsupportedLibrary) {
		const request = App.createRequest({
			url: `${kavitaAPI.url}/Library/libraries`,
			method: 'GET'
		});

		const response = await requestManager.schedule(request, 1);
		const result = JSON.parse(response.data || '[]');

		for (const library of result) {
			if (library.type === 2 || library.type === 4) {
				excludeLibraryIds.push(library.id);
			}
		}
	}

	let result: any = cacheManager.getCachedData(searchRequestToString(searchQuery));
	if (result === undefined) {
		const hasTitle = typeof searchQuery.title === 'string' && searchQuery.title !== '';
		const includedTags = searchQuery.includedTags ?? [];

		const titleSearchTiles: PartialSourceManga[] = [];
		const titleSearchIds = new Set<number>();

		if (hasTitle) {
			const titleRequest = App.createRequest({
				url: `${kavitaAPI.url}/Search/search`,
				param: `?queryString=${encodeURIComponent(searchQuery.title ?? '')}&includeChapterAndFiles=false`,
				method: 'GET'
			});
	
			// We don't want to throw if the server is unavailable
			const titleResponse = await requestManager.schedule(titleRequest, 1);
			// Kavita answers with plain text when no library is included in search
			const titleResult = titleResponse.status < 400 ? parseJSON(titleResponse.data, {}) : {};
	
			for (const manga of titleResult.series ?? []) {
				if (excludeLibraryIds.includes(manga.libraryId) || titleSearchIds.has(manga.seriesId)) {
					continue;
				}
	
				titleSearchIds.add(manga.seriesId);
				titleSearchTiles.push(seriesTile({ id: manga.seriesId, name: manga.name }, kavitaAPI));
			}
	
			if (enableRecursiveSearch) {
				const statementLists = [
					...(titleResult.persons ?? []).map((item: any) => personStatements([item])),
					...(titleResult.genres ?? []).map((item: any) => [{ comparison: FILTER_COMPARISON_CONTAINS, field: FILTER_FIELD['genres'], value: `${item.id}` }]),
					...(titleResult.tags ?? []).map((item: any) => [{ comparison: FILTER_COMPARISON_CONTAINS, field: FILTER_FIELD['tags'], value: `${item.id}` }])
				];
	
				// Extra matches are best effort, so a failed lookup only drops its own results
				const seriesLists = await Promise.all(statementLists.map((statements) =>
					filterSeries(statements, FILTER_COMBINATION_OR, requestManager, kavitaAPI).catch(() => [])
				));

				for (const manga of seriesLists.flat()) {
					if (excludeLibraryIds.includes(manga.libraryId) || titleSearchIds.has(manga.id)) {
						continue;
					}

					titleSearchIds.add(manga.id);
					titleSearchTiles.push(seriesTile(manga, kavitaAPI));
				}
			}
		}
	
		// Series matching every picked tag: all picked genres, all picked tags
		// and each picked person. null means no tag was picked.
		let tagSeries: any[] | null = null;

		if (includedTags.length > 0) {
			const tagIds: Record<string, number[]> = {};
			const peopleNames: string[] = [];
	
			for (const tag of includedTags) {
				const [type, id] = tag.id.split('-');
				if (type === 'people') {
					peopleNames.push(tag.label);
				} else if (type !== undefined && FILTER_FIELD[type] !== undefined && /^\d+$/.test(id ?? '')) {
					tagIds[type] = [...(tagIds[type] ?? []), Number(id)];
				}
			}

			const seriesLists: any[][] = [];

			const statements = Object.entries(tagIds).map(([type, ids]) => ({
				comparison: FILTER_COMPARISON_MUST_CONTAIN,
				field: FILTER_FIELD[type] ?? 0,
				value: ids.join(',')
			}));
			if (statements.length > 0) {
				seriesLists.push(await filterSeries(statements, FILTER_COMBINATION_AND, requestManager, kavitaAPI));
			}

			if (peopleNames.length > 0) {
				// Before Kavita 0.8.4 a person has one id per role, so collect every id for the name.
				const peopleRequest = App.createRequest({
					url: `${kavitaAPI.url}/Metadata/people`,
					method: 'GET'
				});
		
				const peopleResponse = await requestManager.schedule(peopleRequest, 1);
				const peopleResult = parseJSON(peopleResponse.data, []);

				for (const name of peopleNames) {
					const people = Array.isArray(peopleResult) ? peopleResult.filter((person: any) => person.name === name) : [];
					seriesLists.push(people.length > 0 ? await filterSeries(personStatements(people), FILTER_COMBINATION_OR, requestManager, kavitaAPI) : []);
				}
			}

			const [firstList = [], ...otherLists] = seriesLists;
			const otherIds = otherLists.map((list) => new Set(list.map((series) => series.id)));
			tagSeries = firstList.filter((series) => otherIds.every((ids) => ids.has(series.id)) && !excludeLibraryIds.includes(series.libraryId));
		}

		if (tagSeries === null) {
			result = titleSearchTiles;
		} else {
			const tagSearchTiles = tagSeries.map((series) => seriesTile(series, kavitaAPI));
			result = hasTitle ? tagSearchTiles.filter((tile) => titleSearchIds.has(parseInt(tile.mangaId))) : tagSearchTiles;
		}

		cacheManager.setCachedData(searchRequestToString(searchQuery), result);
	}

	result = result.slice(page * pageSize, (page + 1) * pageSize);
	metadata = result.length === 0 ? undefined : { page: page + 1 };

	return App.createPagedResults({
		results: result,
		metadata: metadata
	});
}
