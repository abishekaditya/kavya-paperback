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
// longer reports a person's role, so people are matched in any role.
const PERSON_FILTER_FIELDS = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 29, 30, 31];

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
	const result = JSON.parse(response.data || '[]');
	return Array.isArray(result) ? result : [];
}

function personStatements(personIds: number[]) {
	return PERSON_FILTER_FIELDS.map((field) => ({ comparison: FILTER_COMPARISON_CONTAINS, field: field, value: personIds.join(',') }));
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
		const titleSearchIds: number[] = [];

		if (hasTitle) {
			const titleRequest = App.createRequest({
				url: `${kavitaAPI.url}/Search/search`,
				param: `?queryString=${encodeURIComponent(searchQuery.title ?? '')}`,
				method: 'GET'
			});
	
			// We don't want to throw if the server is unavailable
			const titleResponse = await requestManager.schedule(titleRequest, 1);
			const titleResult = titleResponse.data ? JSON.parse(titleResponse.data) : {};
	
			for (const manga of titleResult.series ?? []) {
				if (excludeLibraryIds.includes(manga.libraryId) || titleSearchIds.includes(manga.seriesId)) {
					continue;
				}
	
				titleSearchIds.push(manga.seriesId);
				titleSearchTiles.push(seriesTile({ id: manga.seriesId, name: manga.name }, kavitaAPI));
			}
	
			if (enableRecursiveSearch) {
				const statementLists = [
					...(titleResult.persons ?? []).map((item: any) => personStatements([item.id])),
					...(titleResult.genres ?? []).map((item: any) => [{ comparison: FILTER_COMPARISON_CONTAINS, field: FILTER_FIELD['genres'], value: `${item.id}` }]),
					...(titleResult.tags ?? []).map((item: any) => [{ comparison: FILTER_COMPARISON_CONTAINS, field: FILTER_FIELD['tags'], value: `${item.id}` }])
				];
	
				for (const statements of statementLists) {
					for (const manga of await filterSeries(statements, FILTER_COMBINATION_OR, requestManager, kavitaAPI)) {
						if (excludeLibraryIds.includes(manga.libraryId) || titleSearchIds.includes(manga.id)) {
							continue;
						}

						titleSearchIds.push(manga.id);
						titleSearchTiles.push(seriesTile(manga, kavitaAPI));
					}
				}
			}
		}
	
		// Series matching every picked tag: all picked genres, all picked tags,
		// and each picked person in any role. null means no tag was picked.
		let tagSeries: any[] | null = null;

		if (includedTags.length > 0) {
			const tagIds: Record<string, number[]> = {};
			const peopleNames: string[] = [];
	
			for (const tag of includedTags) {
				const [type, id] = tag.id.split('-');
				if (type === 'people') {
					peopleNames.push(tag.label);
				} else if (type !== undefined && FILTER_FIELD[type] !== undefined) {
					tagIds[type] = [...(tagIds[type] ?? []), parseInt(id ?? '')];
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
				const peopleResult = JSON.parse(peopleResponse.data || '[]');

				for (const name of peopleNames) {
					const personIds = peopleResult.filter((person: any) => person.name === name).map((person: any) => person.id);
					seriesLists.push(personIds.length > 0 ? await filterSeries(personStatements(personIds), FILTER_COMBINATION_OR, requestManager, kavitaAPI) : []);
				}
			}

			tagSeries = (seriesLists[0] ?? []).filter((series) => seriesLists.every((list) => list.some((other) => other.id === series.id)));
			tagSeries = tagSeries.filter((series) => !excludeLibraryIds.includes(series.libraryId));
		}

		if (tagSeries === null) {
			result = titleSearchTiles;
		} else {
			const tagSearchTiles = tagSeries.map((series) => seriesTile(series, kavitaAPI));
			result = hasTitle ? tagSearchTiles.filter((tile) => titleSearchIds.includes(parseInt(tile.mangaId))) : tagSearchTiles;
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
