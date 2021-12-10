/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import path from 'path';
import fs from 'fs-extra';
import chalk from 'chalk';
import {keyBy, last} from 'lodash';
import {
  aliasedSitePath,
  getEditUrl,
  getFolderContainingFile,
  normalizeUrl,
  parseMarkdownString,
  posixPath,
  Globby,
  normalizeFrontMatterTags,
} from '@docusaurus/utils';
import type {LoadContext} from '@docusaurus/types';

import {getFileLastUpdate} from './lastUpdate';
import {
  DocFile,
  DocMetadataBase,
  DocMetadata,
  DocNavLink,
  LastUpdateData,
  MetadataOptions,
  PluginOptions,
  VersionMetadata,
  LoadedVersion,
} from './types';
import getSlug from './slug';
import {CURRENT_VERSION_NAME} from './constants';
import {getDocsDirPaths} from './versions';
import {stripPathNumberPrefixes} from './numberPrefix';
import {validateDocFrontMatter} from './docFrontMatter';
import {
  SidebarsUtils,
  toDocNavigationLink,
  toNavigationLink,
} from './sidebars/utils';

type LastUpdateOptions = Pick<
  PluginOptions,
  'showLastUpdateAuthor' | 'showLastUpdateTime'
>;

async function readLastUpdateData(
  filePath: string,
  options: LastUpdateOptions,
): Promise<LastUpdateData> {
  const {showLastUpdateAuthor, showLastUpdateTime} = options;
  if (showLastUpdateAuthor || showLastUpdateTime) {
    // Use fake data in dev for faster development.
    const fileLastUpdateData =
      process.env.NODE_ENV === 'production'
        ? await getFileLastUpdate(filePath)
        : {
            author: 'Author',
            timestamp: 1539502055,
          };

    if (fileLastUpdateData) {
      const {author, timestamp} = fileLastUpdateData;
      return {
        lastUpdatedAt: showLastUpdateTime ? timestamp : undefined,
        lastUpdatedBy: showLastUpdateAuthor ? author : undefined,
      };
    }
  }

  return {};
}

export async function readDocFile(
  versionMetadata: Pick<
    VersionMetadata,
    'contentPath' | 'contentPathLocalized'
  >,
  source: string,
  options: LastUpdateOptions,
): Promise<DocFile> {
  const contentPath = await getFolderContainingFile(
    getDocsDirPaths(versionMetadata),
    source,
  );

  const filePath = path.join(contentPath, source);

  const [content, lastUpdate] = await Promise.all([
    fs.readFile(filePath, 'utf-8'),
    readLastUpdateData(filePath, options),
  ]);
  return {source, content, lastUpdate, contentPath, filePath};
}

export async function readVersionDocs(
  versionMetadata: VersionMetadata,
  options: Pick<
    PluginOptions,
    'include' | 'exclude' | 'showLastUpdateAuthor' | 'showLastUpdateTime'
  >,
): Promise<DocFile[]> {
  const sources = await Globby(options.include, {
    cwd: versionMetadata.contentPath,
    ignore: options.exclude,
  });
  return Promise.all(
    sources.map((source) => readDocFile(versionMetadata, source, options)),
  );
}

function doProcessDocMetadata({
  docFile,
  versionMetadata,
  context,
  options,
}: {
  docFile: DocFile;
  versionMetadata: VersionMetadata;
  context: LoadContext;
  options: MetadataOptions;
}): DocMetadataBase {
  const {source, content, lastUpdate, contentPath, filePath} = docFile;
  const {siteDir, i18n} = context;

  const {
    frontMatter: unsafeFrontMatter,
    contentTitle,
    excerpt,
  } = parseMarkdownString(content);
  const frontMatter = validateDocFrontMatter(unsafeFrontMatter);

  const {
    custom_edit_url: customEditURL,

    // Strip number prefixes by default (01-MyFolder/01-MyDoc.md => MyFolder/MyDoc) by default,
    // but allow to disable this behavior with frontmatter
    parse_number_prefixes: parseNumberPrefixes = true,
  } = frontMatter;

  // ex: api/plugins/myDoc -> myDoc
  // ex: myDoc -> myDoc
  const sourceFileNameWithoutExtension = path.basename(
    source,
    path.extname(source),
  );

  // ex: api/plugins/myDoc -> api/plugins
  // ex: myDoc -> .
  const sourceDirName = path.dirname(source);

  const {filename: unprefixedFileName, numberPrefix} = parseNumberPrefixes
    ? options.numberPrefixParser(sourceFileNameWithoutExtension)
    : {filename: sourceFileNameWithoutExtension, numberPrefix: undefined};

  const baseID: string = frontMatter.id ?? unprefixedFileName;
  if (baseID.includes('/')) {
    throw new Error(`Document id "${baseID}" cannot include slash.`);
  }

  // For autogenerated sidebars, sidebar position can come from filename number prefix or frontmatter
  const sidebarPosition: number | undefined =
    frontMatter.sidebar_position ?? numberPrefix;

  // TODO legacy retrocompatibility
  // The same doc in 2 distinct version could keep the same id,
  // we just need to namespace the data by version
  const versionIdPrefix =
    versionMetadata.versionName === CURRENT_VERSION_NAME
      ? undefined
      : `version-${versionMetadata.versionName}`;

  // TODO legacy retrocompatibility
  // I think it's bad to affect the frontmatter id with the dirname?
  function computeDirNameIdPrefix() {
    if (sourceDirName === '.') {
      return undefined;
    }
    // Eventually remove the number prefixes from intermediate directories
    return parseNumberPrefixes
      ? stripPathNumberPrefixes(sourceDirName, options.numberPrefixParser)
      : sourceDirName;
  }

  const unversionedId = [computeDirNameIdPrefix(), baseID]
    .filter(Boolean)
    .join('/');

  // TODO is versioning the id very useful in practice?
  // legacy versioned id, requires a breaking change to modify this
  const id = [versionIdPrefix, unversionedId].filter(Boolean).join('/');

  const docSlug = getSlug({
    baseID,
    source,
    sourceDirName,
    frontmatterSlug: frontMatter.slug,
    stripDirNumberPrefixes: parseNumberPrefixes,
    numberPrefixParser: options.numberPrefixParser,
  });

  // Note: the title is used by default for page title, sidebar label, pagination buttons...
  // frontMatter.title should be used in priority over contentTitle (because it can contain markdown/JSX syntax)
  const title: string = frontMatter.title ?? contentTitle ?? baseID;

  const description: string = frontMatter.description ?? excerpt ?? '';

  const permalink = normalizeUrl([versionMetadata.versionPath, docSlug]);

  function getDocEditUrl() {
    const relativeFilePath = path.relative(contentPath, filePath);

    if (typeof options.editUrl === 'function') {
      return options.editUrl({
        version: versionMetadata.versionName,
        versionDocsDirPath: posixPath(
          path.relative(siteDir, versionMetadata.contentPath),
        ),
        docPath: posixPath(relativeFilePath),
        permalink,
        locale: context.i18n.currentLocale,
      });
    } else if (typeof options.editUrl === 'string') {
      const isLocalized = contentPath === versionMetadata.contentPathLocalized;
      const baseVersionEditUrl =
        isLocalized && options.editLocalizedFiles
          ? versionMetadata.versionEditUrlLocalized
          : versionMetadata.versionEditUrl;
      return getEditUrl(relativeFilePath, baseVersionEditUrl);
    } else {
      return undefined;
    }
  }

  // Assign all of object properties during instantiation (if possible) for
  // NodeJS optimization.
  // Adding properties to object after instantiation will cause hidden
  // class transitions.
  return {
    unversionedId,
    id,
    title,
    description,
    source: aliasedSitePath(filePath, siteDir),
    sourceDirName,
    slug: docSlug,
    permalink,
    editUrl: customEditURL !== undefined ? customEditURL : getDocEditUrl(),
    tags: normalizeFrontMatterTags(versionMetadata.tagsPath, frontMatter.tags),
    version: versionMetadata.versionName,
    lastUpdatedBy: lastUpdate.lastUpdatedBy,
    lastUpdatedAt: lastUpdate.lastUpdatedAt,
    formattedLastUpdatedAt: lastUpdate.lastUpdatedAt
      ? new Intl.DateTimeFormat(i18n.currentLocale).format(
          lastUpdate.lastUpdatedAt * 1000,
        )
      : undefined,
    sidebarPosition,
    frontMatter,
  };
}

export function processDocMetadata(args: {
  docFile: DocFile;
  versionMetadata: VersionMetadata;
  context: LoadContext;
  options: MetadataOptions;
}): DocMetadataBase {
  try {
    return doProcessDocMetadata(args);
  } catch (e) {
    console.error(
      chalk.red(
        `Can't process doc metadata for doc at path "${args.docFile.filePath}" in version "${args.versionMetadata.versionName}"`,
      ),
    );
    throw e;
  }
}

export function addDocNavigation(
  docsBase: DocMetadataBase[],
  sidebarsUtils: SidebarsUtils,
  sidebarFilePath: string,
): LoadedVersion['docs'] {
  const docsById = createDocsByIdIndex(docsBase);

  sidebarsUtils.checkSidebarsDocIds(
    docsBase.flatMap(getDocIds),
    sidebarFilePath,
  );

  // Add sidebar/next/previous to the docs
  function addNavData(doc: DocMetadataBase): DocMetadata {
    const navigation = sidebarsUtils.getDocNavigation(
      doc.unversionedId,
      doc.id,
    );

    const toNavigationLinkByDocId = (
      docId: string | null | undefined,
      type: 'prev' | 'next',
    ): DocNavLink | undefined => {
      if (!docId) {
        return undefined;
      }
      const navDoc = docsById[docId];
      if (!navDoc) {
        // This could only happen if user provided the ID through front matter
        throw new Error(
          `Error when loading ${doc.id} in ${doc.sourceDirName}: the pagination_${type} front matter points to a non-existent ID ${docId}.`,
        );
      }
      return toDocNavigationLink(navDoc);
    };

    const previous: DocNavLink | undefined = doc.frontMatter.pagination_prev
      ? toNavigationLinkByDocId(doc.frontMatter.pagination_prev, 'prev')
      : toNavigationLink(navigation.previous, docsById);
    const next: DocNavLink | undefined = doc.frontMatter.pagination_next
      ? toNavigationLinkByDocId(doc.frontMatter.pagination_next, 'next')
      : toNavigationLink(navigation.next, docsById);

    return {...doc, sidebar: navigation.sidebarName, previous, next};
  }

  const docsWithNavigation = docsBase.map(addNavData);
  // sort to ensure consistent output for tests
  docsWithNavigation.sort((a, b) => a.id.localeCompare(b.id));
  return docsWithNavigation;
}

/**
 * The "main doc" is the "version entry point"
 * We browse this doc by clicking on a version:
 * - the "home" doc (at '/docs/')
 * - the first doc of the first sidebar
 * - a random doc (if no docs are in any sidebar... edge case)
 */
export function getMainDocId({
  docs,
  sidebarsUtils,
}: {
  docs: DocMetadataBase[];
  sidebarsUtils: SidebarsUtils;
}): string {
  function getMainDoc(): DocMetadata {
    const versionHomeDoc = docs.find((doc) => doc.slug === '/');
    const firstDocIdOfFirstSidebar =
      sidebarsUtils.getFirstDocIdOfFirstSidebar();
    if (versionHomeDoc) {
      return versionHomeDoc;
    } else if (firstDocIdOfFirstSidebar) {
      return docs.find(
        (doc) =>
          doc.id === firstDocIdOfFirstSidebar ||
          doc.unversionedId === firstDocIdOfFirstSidebar,
      )!;
    } else {
      return docs[0];
    }
  }

  return getMainDoc().unversionedId;
}

function getLastPathSegment(str: string): string {
  return last(str.split('/'))!;
}

// By convention, Docusaurus considers some docs are "indexes":
// - index.md
// - readme.md
// - <folder>/<folder>.md
//
// Those index docs produce a different behavior
// - Slugs do not end with a weird "/index" suffix
// - Auto-generated sidebar categories link to them as intro
export function isConventionalDocIndex(doc: {
  source: DocMetadataBase['slug'];
  sourceDirName: DocMetadataBase['sourceDirName'];
}): boolean {
  // "@site/docs/folder/subFolder/subSubFolder/myDoc.md" => "myDoc"
  const docName = path.parse(doc.source).name;

  // "folder/subFolder/subSubFolder" => "subSubFolder"
  const lastDirName = getLastPathSegment(doc.sourceDirName);

  const eligibleDocIndexNames = ['index', 'readme', lastDirName.toLowerCase()];

  return eligibleDocIndexNames.includes(docName.toLowerCase());
}

// Return both doc ids
// TODO legacy retro-compatibility due to old versioned sidebars using versioned doc ids
// ("id" should be removed & "versionedId" should be renamed to "id")
export function getDocIds(doc: DocMetadataBase): [string, string] {
  return [doc.unversionedId, doc.id];
}

// docs are indexed by both versioned and unversioned ids at the same time
// TODO legacy retro-compatibility due to old versioned sidebars using versioned doc ids
// ("id" should be removed & "versionedId" should be renamed to "id")
export function createDocsByIdIndex<
  Doc extends {id: string; unversionedId: string},
>(docs: Doc[]): Record<string, Doc> {
  return {
    ...keyBy(docs, (doc) => doc.unversionedId),
    ...keyBy(docs, (doc) => doc.id),
  };
}
