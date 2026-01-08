import { useState, useCallback, useMemo } from 'react';

// =============================================
// Types
// =============================================

export interface PaginationParams {
  page: number;
  pageSize: number;
  offset: number;
}

export interface PaginationState extends PaginationParams {
  setPage: (page: number) => void;
  setPageSize: (size: number) => void;
  nextPage: () => void;
  prevPage: () => void;
  goToFirstPage: () => void;
  goToLastPage: (totalPages: number) => void;
  reset: () => void;
}

export interface PaginatedData<T> {
  data: T[];
  count: number;
}

export interface PaginationInfo {
  currentPage: number;
  totalPages: number;
  totalItems: number;
  pageSize: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
  startItem: number;
  endItem: number;
}

// =============================================
// Hook: usePagination
// =============================================

/**
 * Custom hook for handling pagination state
 * @param defaultPageSize - Default number of items per page (default: 20)
 * @returns Pagination state and control functions
 */
export const usePagination = (defaultPageSize = 20): PaginationState => {
  const [page, setPageState] = useState(1);
  const [pageSize, setPageSizeState] = useState(defaultPageSize);

  // Calculate offset for database queries
  const offset = useMemo(() => (page - 1) * pageSize, [page, pageSize]);

  // Set specific page with bounds checking
  const setPage = useCallback((newPage: number) => {
    if (newPage >= 1) {
      setPageState(newPage);
    }
  }, []);

  // Set page size and reset to first page
  const setPageSize = useCallback((newSize: number) => {
    if (newSize >= 1) {
      setPageSizeState(newSize);
      setPageState(1); // Reset to first page when page size changes
    }
  }, []);

  // Navigation helpers
  const nextPage = useCallback(() => {
    setPageState((prev) => prev + 1);
  }, []);

  const prevPage = useCallback(() => {
    setPageState((prev) => (prev > 1 ? prev - 1 : 1));
  }, []);

  const goToFirstPage = useCallback(() => {
    setPageState(1);
  }, []);

  const goToLastPage = useCallback((totalPages: number) => {
    if (totalPages >= 1) {
      setPageState(totalPages);
    }
  }, []);

  // Reset pagination
  const reset = useCallback(() => {
    setPageState(1);
    setPageSizeState(defaultPageSize);
  }, [defaultPageSize]);

  return {
    page,
    pageSize,
    offset,
    setPage,
    setPageSize,
    nextPage,
    prevPage,
    goToFirstPage,
    goToLastPage,
    reset,
  };
};

// =============================================
// Utility: calculatePaginationInfo
// =============================================

/**
 * Calculate pagination information based on current state and total count
 */
export const calculatePaginationInfo = (
  page: number,
  pageSize: number,
  totalCount: number
): PaginationInfo => {
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const hasNextPage = page < totalPages;
  const hasPrevPage = page > 1;
  const startItem = totalCount === 0 ? 0 : (page - 1) * pageSize + 1;
  const endItem = Math.min(page * pageSize, totalCount);

  return {
    currentPage: page,
    totalPages,
    totalItems: totalCount,
    pageSize,
    hasNextPage,
    hasPrevPage,
    startItem,
    endItem,
  };
};

// =============================================
// Utility: getPageNumbers
// =============================================

/**
 * Generate array of page numbers to display in pagination UI
 * Shows first, last, current and surrounding pages with ellipsis
 */
export const getPageNumbers = (
  currentPage: number,
  totalPages: number,
  maxVisible = 5
): (number | 'ellipsis')[] => {
  if (totalPages <= maxVisible) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }

  const pages: (number | 'ellipsis')[] = [];
  const sidePages = Math.floor((maxVisible - 3) / 2); // -3 for first, current, last

  // Always show first page
  pages.push(1);

  // Calculate range around current page
  let rangeStart = Math.max(2, currentPage - sidePages);
  let rangeEnd = Math.min(totalPages - 1, currentPage + sidePages);

  // Adjust range if at the beginning or end
  if (currentPage <= sidePages + 2) {
    rangeEnd = Math.min(totalPages - 1, maxVisible - 1);
  }
  if (currentPage >= totalPages - sidePages - 1) {
    rangeStart = Math.max(2, totalPages - maxVisible + 2);
  }

  // Add ellipsis before range if needed
  if (rangeStart > 2) {
    pages.push('ellipsis');
  }

  // Add pages in range
  for (let i = rangeStart; i <= rangeEnd; i++) {
    pages.push(i);
  }

  // Add ellipsis after range if needed
  if (rangeEnd < totalPages - 1) {
    pages.push('ellipsis');
  }

  // Always show last page
  if (totalPages > 1) {
    pages.push(totalPages);
  }

  return pages;
};

export default usePagination;
