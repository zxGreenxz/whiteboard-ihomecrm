import { describe, it, expect } from 'vitest';

import { resolveRoomPrice } from '../roomPrice';

describe('resolveRoomPrice', () => {
  it('phòng đang thuê giá khác niêm yết: số chính là giá hợp đồng, số phụ là giá niêm yết', () => {
    expect(resolveRoomPrice({ roomRentPrice: 6_600_000, contractRentPrice: 6_100_000 })).toEqual({
      primary: 6_100_000,
      listed: 6_600_000,
    });
  });

  it('giá hợp đồng cao hơn niêm yết vẫn lộ cả hai số', () => {
    expect(resolveRoomPrice({ roomRentPrice: 6_000_000, contractRentPrice: 6_500_000 })).toEqual({
      primary: 6_500_000,
      listed: 6_000_000,
    });
  });

  it('giá hợp đồng bằng giá niêm yết: không in số phụ trùng lặp', () => {
    expect(resolveRoomPrice({ roomRentPrice: 7_300_000, contractRentPrice: 7_300_000 })).toEqual({
      primary: 7_300_000,
      listed: null,
    });
  });

  it('phòng không có hợp đồng: số chính là giá niêm yết, không số phụ', () => {
    expect(resolveRoomPrice({ roomRentPrice: 6_200_000, contractRentPrice: undefined })).toEqual({
      primary: 6_200_000,
      listed: null,
    });
  });

  it('hợp đồng thiếu giá (null) thì rơi về giá niêm yết chứ không hiện 0', () => {
    expect(resolveRoomPrice({ roomRentPrice: 6_200_000, contractRentPrice: null })).toEqual({
      primary: 6_200_000,
      listed: null,
    });
  });

  it('phòng chưa đặt giá niêm yết mà có hợp đồng: vẫn hiện giá hợp đồng, không số phụ', () => {
    expect(resolveRoomPrice({ roomRentPrice: null, contractRentPrice: 5_000_000 })).toEqual({
      primary: 5_000_000,
      listed: null,
    });
  });

  it('không có giá nào: số chính là 0 để thẻ vẫn vẽ được', () => {
    expect(resolveRoomPrice({ roomRentPrice: null, contractRentPrice: null })).toEqual({
      primary: 0,
      listed: null,
    });
  });

  it('giá hợp đồng 0 là con số thật (miễn phí), không phải thiếu dữ liệu', () => {
    expect(resolveRoomPrice({ roomRentPrice: 6_000_000, contractRentPrice: 0 })).toEqual({
      primary: 0,
      listed: 6_000_000,
    });
  });
});
