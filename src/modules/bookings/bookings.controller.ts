import { MovieSessionService } from './../movie-session/movie-session.service'
import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Delete,
  BadRequestException,
  NotFoundException,
  UseFilters,
  ParseIntPipe,
  UseGuards,
  ForbiddenException,
} from '@nestjs/common'
import { ApiTags, ApiOperation, ApiOkResponse } from '@nestjs/swagger'
import { PrismaClientExceptionFilter } from '../prisma/prisma-client-exception'
import { MIN_DAYS_UNTIL_BOOKING } from './booking.constants'
import { BookingService } from './bookings.service'
import {
  FindMergedCinemaBookingSeatingSchemaDto,
  FindSeatBookingDto,
  CreateBookingDto,
} from './dto'
import { BookingEntity } from './entity'
import {
  getDaysGapRelatevilyNow,
  generateSourceBookingSchema,
  checkIfDesiredSeatsCanExist,
  convertSeatsArrayToString,
} from './helpers'
import { SeatsInCinemaHallService } from '../seats-in-cinema-hall/seats-in-cinema-hall.service'
import { MergedFullCinemaBookingSeatingSchema, SeatPosWithType } from '../../common/types'
import { DeleteManyDto } from '../../common/dtos/common'
import { AtGuard } from '../auth-jwt/guards'
import { GetCurrentUserId } from '../auth-jwt/decorators'

@Controller('bookings')
@UseGuards(AtGuard)
@ApiTags('Bookings')
@UseFilters(PrismaClientExceptionFilter)
export class BookingsController {
  constructor(
    private readonly bookingsService: BookingService,
    private readonly seatsInCinemaHallService: SeatsInCinemaHallService,
    private readonly movieSessionService: MovieSessionService,
  ) {}

  @Get('booking-schema/:movieSessionId')
  @ApiOperation({
    description: 'Get booking schema for movie session (by movieSessionId)',
  })
  @ApiOkResponse({
    type: FindMergedCinemaBookingSeatingSchemaDto,
    isArray: true,
  })
  async findCinemaBookingSeatingSchemaByMovieSessionId(
    @Param('movieSessionId', ParseIntPipe) movieSessionId: number,
  ): Promise<MergedFullCinemaBookingSeatingSchema> {
    const cinemaBookingSeatingSchema =
      await this.bookingsService.findCinemaBookingSeatingSchemaByMovieSessionId(movieSessionId)

    return cinemaBookingSeatingSchema
  }

  // TODO: only for admin permission
  @Get('/users/:userId')
  @ApiOperation({ description: "Get user's bookings (admin permission is required)" })
  @ApiOkResponse({ type: BookingEntity })
  async findBookingsByUser(
    @Param('userId', ParseIntPipe) userId: number,
  ): Promise<BookingEntity[]> {
    const userBookingsData = await this.bookingsService.findBookingsDataByUser(userId)

    const userBookings = await this.bookingsService.findUserBookingsWithSeats(userBookingsData)

    const userBookingsEntities = userBookings.map(
      ({ seatsByBookingId, booking }) => new BookingEntity(seatsByBookingId, booking),
    )

    return userBookingsEntities
  }

  @Get('/users')
  @ApiOperation({ description: 'Get bookings for current user' })
  @ApiOkResponse({ type: BookingEntity })
  async findBookingsForCurrentUser(@GetCurrentUserId() userId: number): Promise<BookingEntity[]> {
    const userBookingsData = await this.bookingsService.findBookingsDataByUser(userId)

    const userBookingsWithSeats = await this.bookingsService.findUserBookingsWithSeats(
      userBookingsData,
    )

    const userBookingsEntities = userBookingsWithSeats.map(
      ({ seatsByBookingId, booking }) => new BookingEntity(seatsByBookingId, booking),
    )

    return userBookingsEntities
  }

  @Delete('/users/:movieSessionId')
  @ApiOperation({ description: 'Cancel all bookings for current user' })
  @ApiOkResponse({ type: DeleteManyDto })
  async cancelAllBookingForMovieSessionForUser(
    @Param('movieSessionId', ParseIntPipe) movieSessionId: number,
    @GetCurrentUserId() userId: number,
  ): Promise<DeleteManyDto> {
    const movieSession = await this.movieSessionService.findOneMovieSession({ id: movieSessionId })

    if (!movieSession) {
      throw new NotFoundException(`Could not find movie session with ${movieSessionId}.`)
    }

    const deletedBookings = await this.bookingsService.cancelAllBookingForMovieSessionForUser({
      movieSessionId,
      userId,
    })

    return deletedBookings
  }

  @Get('seats/:bookingId')
  @ApiOperation({ description: 'Get seats by bookingId' })
  @ApiOkResponse({ type: FindSeatBookingDto, isArray: true })
  async findSeatsByBookingId(
    @Param('bookingId', ParseIntPipe) bookingId: number,
  ): Promise<SeatPosWithType[]> {
    const booking = await this.bookingsService.findOneBooking({ id: bookingId })

    if (!booking) {
      throw new NotFoundException(`Could not find booking with ${bookingId}.`)
    }

    const movieSession = await this.movieSessionService.findOneMovieSession({
      id: booking.movieSessionId,
    })

    if (!movieSession) {
      throw new NotFoundException(`Could not movie session with ${booking.movieSessionId}.`)
    }

    const mergedFullCinemaBookingSeatingSchema =
      await this.bookingsService.findCinemaBookingSeatingSchemaByMovieSessionId(movieSession.id)

    const seatsByBookingId = await this.bookingsService.findSeatsByBookingId(
      mergedFullCinemaBookingSeatingSchema,
      bookingId,
    )

    return seatsByBookingId
  }

  @Get(':bookingId')
  @ApiOperation({ description: 'Get booking info by bookingId' })
  @ApiOkResponse({ type: BookingEntity })
  async getBookingByBookingId(
    @Param('bookingId', ParseIntPipe) bookingId: number,
  ): Promise<BookingEntity> {
    const booking = await this.bookingsService.findOneBooking({ id: bookingId })

    if (!booking) {
      throw new NotFoundException(`Could not find booking with ${bookingId}.`)
    }

    const movieSession = await this.movieSessionService.findOneMovieSession({
      id: booking.movieSessionId,
    })

    if (!movieSession) {
      throw new NotFoundException(`Could not movie session with ${booking.movieSessionId}.`)
    }

    const mergedFullCinemaBookingSeatingSchema =
      await this.bookingsService.findCinemaBookingSeatingSchemaByMovieSessionId(movieSession.id)

    const seatsByBookingId = await this.bookingsService.findSeatsByBookingId(
      mergedFullCinemaBookingSeatingSchema,
      bookingId,
    )

    const clientBooking = new BookingEntity(seatsByBookingId, booking)

    return clientBooking
  }

  @Post()
  @ApiOperation({ description: 'Create booking' })
  @ApiOkResponse({ type: BookingEntity })
  async createBooking(
    @Body() dto: CreateBookingDto,
    @GetCurrentUserId() userId: number,
  ): Promise<BookingEntity> {
    const { desiredSeats, movieSessionId } = dto

    if (!userId) {
      throw new NotFoundException(`User with id: ${userId} is not exist`)
    }

    const movieSession = await this.movieSessionService.findOneMovieSession({ id: movieSessionId })

    // 1. Check if such movie session exists
    if (!movieSession) {
      throw new NotFoundException(`Movie session with id: ${movieSessionId} is not exist`)
    }

    const daysGapRelatevilyNow = getDaysGapRelatevilyNow(movieSession.startDate)

    // 2. Check date for booking (if it's allowed)
    const isBookingAllowed = daysGapRelatevilyNow < MIN_DAYS_UNTIL_BOOKING

    if (!isBookingAllowed) {
      throw new BadRequestException(
        `Wait please ${daysGapRelatevilyNow - MIN_DAYS_UNTIL_BOOKING} day(s) to make a booking`,
      )
    }

    const cinemaSeatingSchema = await this.seatsInCinemaHallService.findCinemaHallSeatingSchema(
      movieSession.cinemaHallId,
    )
    const sourceBookingSchema = generateSourceBookingSchema(cinemaSeatingSchema)

    // 3. Check if desired seats ∈ bookingSeats
    const { isDesiredSeatsCanExist, wrongSeats } = checkIfDesiredSeatsCanExist({
      set: sourceBookingSchema,
      subset: desiredSeats,
    })

    if (!isDesiredSeatsCanExist) {
      const wrongSeatsString = convertSeatsArrayToString(wrongSeats)
      throw new BadRequestException(
        `These seats are outside of booking schema: ${wrongSeatsString}`,
      )
    }

    // 4. Check if these seat(s) are not reserved yet
    const { allSeatsAreAvailable, bookedSeats } =
      await this.bookingsService.checkIfSeatsAreAvailableForBooking(movieSessionId, desiredSeats)

    // 5. If some seats are reserved throw error cause such booking can't be created
    if (!allSeatsAreAvailable) {
      const bookedSeatsString = convertSeatsArrayToString(bookedSeats)
      throw new BadRequestException(`These seats are already booked: ${bookedSeatsString}`)
    }

    // 6. If all seats from desired are available for booking then create such booking
    const newBooking = await this.bookingsService.createBooking(
      { movieSessionId, userId },
      desiredSeats,
    )

    const mergedFullCinemaBookingSeatingSchema =
      await this.bookingsService.findCinemaBookingSeatingSchemaByMovieSessionId(movieSessionId)

    const seatsByBookingId = await this.bookingsService.findSeatsByBookingId(
      mergedFullCinemaBookingSeatingSchema,
      newBooking.id,
    )

    const newClientBookingClientBooking = new BookingEntity(seatsByBookingId, newBooking)

    return newClientBookingClientBooking
  }

  @Delete(':bookingId')
  @ApiOperation({ description: 'Cancel booking by bookingId' })
  @ApiOkResponse({ type: BookingEntity })
  async cancelBooking(
    @Param('bookingId', ParseIntPipe) bookingId: number,
    @GetCurrentUserId() userId: number,
  ): Promise<BookingEntity> {
    const booking = await this.bookingsService.findOneBooking({ id: bookingId })

    if (!booking) {
      throw new NotFoundException(`Could not find booking with ${bookingId}.`)
    }

    if (booking.userId !== userId) {
      throw new ForbiddenException(`The booking with id = ${bookingId} doesn't belong to you.`)
    }

    const movieSession = await this.movieSessionService.findOneMovieSession({
      id: booking.movieSessionId,
    })

    if (!movieSession) {
      throw new NotFoundException(`Could not movie session with ${booking.movieSessionId}.`)
    }

    const mergedFullCinemaBookingSeatingSchema =
      await this.bookingsService.findCinemaBookingSeatingSchemaByMovieSessionId(movieSession.id)

    const seatsByBookingId = await this.bookingsService.findSeatsByBookingId(
      mergedFullCinemaBookingSeatingSchema,
      bookingId,
    )

    const clientCanceledBooking = new BookingEntity(seatsByBookingId, booking)

    await this.bookingsService.cancelBooking(bookingId)

    return clientCanceledBooking
  }
}
